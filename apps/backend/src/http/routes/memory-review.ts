import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProposeMemoryRequest, EditMemoryRequest, ReviewMemoryRequest } from "@kuinest/contracts";
import type { ApiServices } from "../../application/service.js";
import type { MemoryReviewAccess } from "../../storage/memory-review.js";
import { ensure } from "../../application/errors.js";
const ref=(name:string)=>({$ref:"urn:kuinest:0.3:"+name+"#"});
const params={type:"object",properties:{id:{type:"string",minLength:1,maxLength:256}},required:["id"],additionalProperties:false};
const response=(name:string)=>Object.fromEntries([[200,ref(name)],...[400,401,403,404,409,413,429,500,503].map(s=>[s,ref("apiError")])]);
export function registerMemoryReview(app:FastifyInstance,api:ApiServices,authenticate:(r:FastifyRequest)=>Promise<void>,json:(r:FastifyRequest)=>Promise<void>,owner:(r:FastifyRequest)=>string,store?:MemoryReviewAccess){
 const ready=()=>{ensure(store,"SERVICE_NOT_READY");return store;};
 const character=(r:FastifyRequest,id:string)=>{api.queries.requireConversation(owner(r),id);return ready().characterForConversation(owner(r),id);};
 app.get<{Params:{id:string};Querystring:{cursor?:string;limit?:string}}>("/api/v1/conversations/:id/memory-proposals",{preHandler:authenticate,schema:{params,querystring:{type:"object",properties:{cursor:{type:"string",minLength:1,maxLength:256},limit:{type:"string",pattern:"^(?:[1-9]|[1-4][0-9]|50)$"}},required:[],additionalProperties:false},response:response("memoryProposalPage")}},async r=>ready().list(owner(r),character(r,r.params.id),r.query.cursor,Number(r.query.limit??20)));
 app.post<{Params:{id:string};Body:ProposeMemoryRequest}>("/api/v1/conversations/:id/memory-proposals",{onRequest:json,preHandler:authenticate,schema:{params,body:ref("proposeMemoryRequest"),response:response("memoryProposal")}},async r=>ready().proposeUser(owner(r),character(r,r.params.id),r.body));
 app.get<{Params:{id:string}}>("/api/v1/memory-proposals/:id",{preHandler:authenticate,schema:{params,response:response("memoryProposal")}},async r=>ready().get(owner(r),r.params.id));
 app.patch<{Params:{id:string};Body:EditMemoryRequest}>("/api/v1/memory-proposals/:id",{onRequest:json,preHandler:authenticate,schema:{params,body:ref("editMemoryRequest"),response:response("memoryProposal")}},async r=>ready().edit(owner(r),r.params.id,r.body));
 for(const [action,status] of [["confirm","confirmed"],["reject","rejected"]] as const)app.post<{Params:{id:string};Body:ReviewMemoryRequest}>("/api/v1/memory-proposals/:id/"+action,{onRequest:json,preHandler:authenticate,schema:{params,body:ref("reviewMemoryRequest"),response:response("memoryProposal")}},async r=>ready().decide(owner(r),r.params.id,r.body,status));
}
