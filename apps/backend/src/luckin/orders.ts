import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {LuckinReader,LuckinResult} from '../mcp/luckin-policy.js';
import {parseLuckinOrdersCall} from '../mcp/luckin-orders-policy.js';
import {parseLuckinPreviewCall} from '../mcp/luckin-preview-policy.js';
import {IntentStore} from './intent-store.js';
export type OrderBinding={ownerId:string;clientId:string;grantId:string;resource:string};
type Product={productId:number;skuCode:string;amount:number;name:string;spec:string};
type Quote={shop:{deptId:number;name:string;address:string;longitude:number;latitude:number};products:Product[];totalMinor:number;discountMinor:number;payableMinor:number;coupons:string[];digest:string};
type Creation={orderId:string;paymentQrCodeUrl?:string;actualPayableMinor?:number;needPay?:boolean;priceChanged:boolean;qrUnavailable:boolean};
export type OrderIntent={version:1;id:string;binding:OrderBinding;draft:Record<string,unknown>;quote:Quote;state:'PREVIEWED'|'APPROVED'|'SUBMITTING'|'UNKNOWN'|'CREATED'|'REQUOTE_REQUIRED';createdAt:number;expires:number;nonce?:string;approvedUntil?:number;creation?:Creation};
type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=512):string=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f]/.test(v))throw Error('ORDER_RESPONSE_INVALID');return v;};
const positive=(v:unknown):number=>{if(!Number.isSafeInteger(v)||Number(v)<=0)throw Error('ORDER_RESPONSE_INVALID');return Number(v);};
export function yuanMinor(v:unknown):number{
 if(typeof v!=='number'&&typeof v!=='string')throw Error('ORDER_AMOUNT_INVALID');
 const m=/^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(String(v));if(!m)throw Error('ORDER_AMOUNT_INVALID');
 const n=BigInt(m[1]!)*100n+BigInt((m[2]??'').padEnd(2,'0'));if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('ORDER_AMOUNT_INVALID');return Number(n);
}
export function responseData(result:LuckinResult):Obj{
 if(result.isError)throw Error('ORDER_UPSTREAM_FAILED');const candidates=new Map<string,Obj>();
 const add=(v:unknown)=>{if(!object(v)||v.code!==0||v.success===false||!object(v.data))return;candidates.set(JSON.stringify(v.data),v.data);};
 for(const block of result.content)try{add(JSON.parse(block.text));}catch{}
 add(result.structuredContent);if(candidates.size!==1)throw Error('ORDER_RESPONSE_INVALID');return [...candidates.values()][0]!;
}
export function orderQuote(result:LuckinResult,draft:Record<string,unknown>):Quote{
 const d=responseData(result),shop=d.shopInfo;if(!object(shop)||positive(shop.deptId)!==draft.deptId)throw Error('ORDER_SHOP_MISMATCH');
 if(typeof shop.longitude!=='number'||!Number.isFinite(shop.longitude)||Math.abs(shop.longitude)>180||typeof shop.latitude!=='number'||!Number.isFinite(shop.latitude)||Math.abs(shop.latitude)>90)throw Error('ORDER_RESPONSE_INVALID');
 if(!Array.isArray(d.productInfoList)||d.productInfoList.length<1||d.productInfoList.length>20)throw Error('ORDER_PRODUCTS_MISMATCH');
 const products:Product[]=d.productInfoList.map((p:unknown)=>{if(!object(p))throw Error('ORDER_RESPONSE_INVALID');return {productId:positive(p.productId),skuCode:text(p.skuCode,256),amount:positive(p.amount),name:text(p.name,256),spec:text(p.additionDesc,1024)};});
 const basket=(rows:Record<string,unknown>[])=>{const m=new Map<string,number>();for(const p of rows){const k=String(p.productId)+'/'+String(p.skuCode);m.set(k,(m.get(k)??0)+Number(p.amount));}return JSON.stringify([...m].sort(([a],[b])=>a.localeCompare(b)));};
 if(basket(products)!==basket(draft.productList as Record<string,unknown>[]))throw Error('ORDER_PRODUCTS_MISMATCH');
 const totalMinor=yuanMinor(d.totalInitialPrice),discountMinor=yuanMinor(d.privilegeMoney),payableMinor=yuanMinor(d.discountPrice);
 if(totalMinor-discountMinor!==payableMinor||discountMinor>totalMinor)throw Error('ORDER_AMOUNT_MISMATCH');
 if(!Array.isArray(d.couponCodeList)||d.couponCodeList.length>50)throw Error('ORDER_COUPONS_INVALID');
 const coupons=d.couponCodeList.map((c:unknown)=>{const s=text(c,256);if(s.includes('[REDACTED]'))throw Error('ORDER_COUPONS_INVALID');return s;});
 const basis={shop:{deptId:shop.deptId as number,name:text(shop.deptName),address:text(shop.address,1024),longitude:shop.longitude,latitude:shop.latitude},products:products.sort((a,b)=>(a.productId+'/'+a.skuCode).localeCompare(b.productId+'/'+b.skuCode)),totalMinor,discountMinor,payableMinor,coupons};
 return {...basis,digest:createHash('sha256').update(JSON.stringify(basis)).digest('hex')};
}
export function paymentQr(value:unknown):string|undefined{
 if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020<>"'`]/.test(value)||value.includes('[REDACTED]'))return undefined;
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!(u.hostname==='lkcoffee.com'||u.hostname.endsWith('.lkcoffee.com')))return undefined;return value;}catch{return undefined;}
}
const ok=(data:unknown):LuckinResult=>({isError:false,content:[{type:'text',text:JSON.stringify(data)}],...(object(data)?{structuredContent:data}:{})});
const same=(a:OrderBinding,b:OrderBinding)=>['ownerId','clientId','grantId','resource'].every(k=>a[k as keyof OrderBinding]===b[k as keyof OrderBinding]);
export class LuckinOrdersService{
 readonly store:IntentStore;readonly origin:string;
 constructor(private options:{root:string;publicOrigin:string;reader:LuckinReader;active:(binding:OrderBinding)=>boolean;createEnabled?:boolean;now?:()=>number}){this.store=new IntentStore(options.root);this.origin=options.publicOrigin;}
 private now(){return (this.options.now??Date.now)();}
 private active(binding:OrderBinding){if(!this.options.active(binding))throw Error('ORDER_AUTH_REVOKED');}
 private owned(id:string,binding:OrderBinding){this.active(binding);const v=this.store.get(id);if(!same(v.binding,binding))throw Error('ORDER_INTENT_NOT_FOUND');return v;}
 private summary(v:OrderIntent){return {intentId:v.id,state:v.state==='SUBMITTING'?'UNKNOWN':v.state,expiresAt:new Date(v.expires).toISOString(),currency:'CNY',unit:'yuan',shop:v.quote.shop,products:v.quote.products,totalPrice:v.quote.totalMinor/100,discount:v.quote.discountMinor/100,payable:v.quote.payableMinor/100,couponCount:v.quote.coupons.length,confirmationUrl:this.origin+'/api/luckin/orders/confirm/'+v.id,creationEnabled:this.options.createEnabled===true,notice:'请展示完整门店、规格、数量和应付金额；本人打开确认链接批准后才能提交，付款仍由本人完成。'};}
 private created(v:OrderIntent){return {...this.summary(v),orderId:v.creation!.orderId,needPay:v.creation!.needPay,...(v.creation!.paymentQrCodeUrl&&v.creation!.needPay!==false?{payOrderQrCodeUrl:v.creation!.paymentQrCodeUrl}:{}),actualPayable:v.creation!.actualPayableMinor===undefined?undefined:v.creation!.actualPayableMinor/100,priceChanged:v.creation!.priceChanged,qrUnavailable:v.creation!.qrUnavailable,paymentStatus:'not_checked',notice:v.creation!.priceChanged?'创建返回金额与批准报价不同，请核对实际应付后自行决定是否付款，不会自动付款或取消。':v.creation!.needPay===false?'订单已创建，官方返回无需支付，请查询订单状态；不要重新创建。':'订单已创建。请使用官方二维码自行付款，然后调用queryOrderDetailInfo核实状态。不要重新创建。'};}
 async call(binding:OrderBinding,name:unknown,args:unknown,signal?:AbortSignal):Promise<LuckinResult>{
  const checked=parseLuckinOrdersCall(name,args);
  // 一次MCP请求的报价复核+创建共享25秒预算，低于现有nginx 30秒。
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000);
  try{
   this.active(binding);
   if(checked.name==='previewOrder'){
    const draft=parseLuckinPreviewCall('previewOrder',checked.args).args;
    const quote=orderQuote(await this.options.reader.call('previewOrder',draft,signal),draft);this.active(binding);
    const v:OrderIntent={version:1,id:randomUUID(),binding:{...binding},draft,quote,state:'PREVIEWED',createdAt:this.now(),expires:this.now()+300000,nonce:randomBytes(32).toString('base64url')};
    this.store.create(v);return ok(this.summary(v));
   }
   if(checked.name==='createOrder')return ok(await this.submit(String(checked.args.intentId),binding,signal));
   if(checked.name==='queryOrderDetailInfo')return ok(await this.query(String(checked.args.intentId),binding,signal));
   return await this.options.reader.call(checked.name,checked.args,signal);
  }catch(e){const message=e instanceof Error?e.message:'';const code=/^(ORDER_[A-Z_]+|INTENT_[A-Z_]+)$/.test(message)?message:'ORDER_TEMPORARILY_UNAVAILABLE';return {isError:true,content:[{type:'text',text:JSON.stringify({code,notice:'未确认不得下单。若提交结果未知，请在瑞幸官方账户核实，禁止自动重试创建或取消。'})}]};}
 }
 review(id:string,ownerId:string){const v=this.store.get(id);this.active(v.binding);if(v.binding.ownerId!==ownerId)throw Error('ORDER_INTENT_NOT_FOUND');if(v.state!=='PREVIEWED'||v.expires<=this.now())throw Error('ORDER_CONFIRMATION_EXPIRED');return {...this.summary(v),nonce:v.nonce};}
 async approve(id:string,ownerId:string,nonce:unknown){
  return this.store.lock(id,async()=>{const v=this.store.get(id);this.active(v.binding);if(v.binding.ownerId!==ownerId)throw Error('ORDER_INTENT_NOT_FOUND');
   if(v.state!=='PREVIEWED'||v.expires<=this.now())throw Error('ORDER_CONFIRMATION_EXPIRED');
   if(typeof nonce!=='string'||!v.nonce||nonce.length!==v.nonce.length||!timingSafeEqual(Buffer.from(nonce),Buffer.from(v.nonce)))throw Error('ORDER_CONFIRMATION_INVALID');
   v.state='APPROVED';v.approvedUntil=Math.min(v.expires,this.now()+120000);delete v.nonce;this.store.put(v);return {state:'APPROVED',notice:'本笔已批准，请回到ChatGPT让小葵继续提交；此页面没有创建订单或付款。'};
  });
 }
 private async submit(id:string,binding:OrderBinding,signal?:AbortSignal){
  return this.store.lock(id,async()=>{
   const v=this.owned(id,binding);if(v.state==='CREATED'&&v.creation)return this.created(v);
   if(v.state==='SUBMITTING'||v.state==='UNKNOWN')throw Error('ORDER_RESULT_UNKNOWN_DO_NOT_RETRY');
   if(this.options.createEnabled!==true)throw Error('ORDER_CREATE_DISABLED');
   if(v.state!=='APPROVED'||!v.approvedUntil||v.approvedUntil<=this.now()||v.expires<=this.now())throw Error('ORDER_APPROVAL_REQUIRED');
   // 提交前重查报价；任何金额、规格、数量、门店、券变化都消耗旧批准并停止。
   const current=orderQuote(await this.options.reader.call('previewOrder',v.draft,signal),v.draft);
   if(current.digest!==v.quote.digest){v.state='REQUOTE_REQUIRED';delete v.approvedUntil;this.store.put(v);throw Error('ORDER_QUOTE_CHANGED_RECONFIRM');}
   this.active(binding);if(v.approvedUntil<=this.now()||v.expires<=this.now()||signal?.aborted)throw Error('ORDER_APPROVAL_REQUIRED');
   v.state='SUBMITTING';delete v.approvedUntil;this.store.put(v); // fsync成功后才发出任何create请求；崩溃后不再次提交。
   try{
    const d=responseData(await this.options.reader.call('createOrder',{...v.draft,longitude:v.quote.shop.longitude,latitude:v.quote.shop.latitude,couponCodeList:[...v.quote.coupons]},signal));
    const orderId=typeof d.orderIdStr==='string'&&/^\d{1,32}$/.test(d.orderIdStr)?d.orderIdStr:typeof d.orderId==='string'&&/^\d{1,32}$/.test(d.orderId)?d.orderId:Number.isSafeInteger(d.orderId)&&d.orderId>0?String(d.orderId):undefined;
    if(!orderId)throw Error('ORDER_ID_UNVERIFIED');
    const qr=paymentQr(d.payOrderQrCodeUrl);let actual:number|undefined;try{actual=yuanMinor(d.discountPrice);}catch{}
    v.creation={orderId,...(qr?{paymentQrCodeUrl:qr}:{}),...(typeof d.needPay==='boolean'?{needPay:d.needPay}:{}),...(actual===undefined?{}:{actualPayableMinor:actual}),priceChanged:actual===undefined||actual!==v.quote.payableMinor,qrUnavailable:d.needPay!==false&&!qr};v.state='CREATED';this.store.put(v);return this.created(v);
   }catch{v.state='UNKNOWN';this.store.put(v);throw Error('ORDER_RESULT_UNKNOWN_DO_NOT_RETRY');}
  });
 }
 private async query(id:string,binding:OrderBinding,signal?:AbortSignal){
  const v=this.owned(id,binding);if(v.state!=='CREATED'||!v.creation)return {...this.summary(v),notice:'尚无已知订单号；未确认或结果未知时不得重复创建。'};
  const d=responseData(await this.options.reader.call('queryOrderDetailInfo',{orderId:v.creation.orderId},signal));
  if(typeof d.orderId!=='string'||d.orderId!==v.creation.orderId)throw Error('ORDER_ID_MISMATCH');
  // 20仅说明下单成功；制作/取餐/完成才作为已履约付款状态证据，避免把建单当支付。
  const status=d.orderStatus,paid=[30,60,80].includes(status);const names:Record<number,string>={10:'待付款',20:'下单成功',30:'制作中',60:'等待取餐',80:'已完成',100:'已取消'};
  const pickup=paid&&object(d.takeMealCodeInfo)&&typeof d.takeMealCodeInfo.code==='string'?text(d.takeMealCodeInfo.code,128):undefined;
  return {intentId:id,orderId:v.creation.orderId,orderStatus:status,orderStatusName:names[status]??'未知状态',paymentStatus:status===10?'pending':paid?'confirmed':'unknown',...(pickup?{takeMealCode:pickup}:{}),...(paid&&typeof d.aboutTime==='number'&&Number.isSafeInteger(d.aboutTime)?{aboutTime:d.aboutTime}:{})};
 }
}
