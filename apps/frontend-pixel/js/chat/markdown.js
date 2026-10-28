// DOM 渲染有限 Markdown；HTML 始终作为文字，不执行消息中的标签。
function inline(parent, source) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    parent.append(document.createTextNode(source.slice(offset, match.index)));
    const token = match[0]; let node;
    if (token.startsWith('`')) { node = document.createElement('code'); node.textContent = token.slice(1, -1); }
    else if (token.startsWith('**')) { node = document.createElement('strong'); node.textContent = token.slice(2, -2); }
    else if (token.startsWith('*')) { node = document.createElement('em'); node.textContent = token.slice(1, -1); }
    else {
      const link = token.match(/^\[([^\]]+)\]\((.+)\)$/);
      try {
        const url = new URL(link[2]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        node = document.createElement('a'); node.href = url.href; node.textContent = link[1]; node.target = '_blank'; node.rel = 'noopener noreferrer';
      } catch { node = document.createTextNode(token); }
    }
    parent.append(node); offset = match.index + token.length;
  }
  parent.append(document.createTextNode(source.slice(offset)));
}
export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment(), lines = text.replaceAll('\r\n', '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(), body = []; index++;
      while (index < lines.length && !lines[index].startsWith('```')) body.push(lines[index++]);
      if (index < lines.length) index++;
      const box = document.createElement('div'); box.className = 'code-box';
      const head = document.createElement('div'); head.className = 'code-head';
      const label = document.createElement('span'); label.textContent = language || '代码';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'xk-btn'; button.textContent = '复制';
      const code = document.createElement('code'); code.textContent = body.join('\n'); const pre = document.createElement('pre'); pre.append(code);
      button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(code.textContent); button.textContent = '已复制'; } catch { button.textContent = '请选取复制'; } });
      head.append(label, button); box.append(head, pre); fragment.append(box); continue;
    }
    if (!line.trim()) { index++; continue; }
    let element;
    if (/^#{1,4} /.test(line)) { const level = line.indexOf(' '); element = document.createElement('h' + Math.min(4, level + 1)); inline(element, line.slice(level + 1)); index++; }
    else if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const ordered = /^\d+\. /.test(line); element = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length && (ordered ? /^\d+\. / : /^[-*] /).test(lines[index])) { const li = document.createElement('li'); inline(li, lines[index++].replace(ordered ? /^\d+\. / : /^[-*] /, '')); element.append(li); }
    } else if (line.startsWith('> ')) { element = document.createElement('blockquote'); inline(element, line.slice(2)); index++; }
    else {
      element = document.createElement('p'); const block = [];
      while (index < lines.length && lines[index].trim() && (block.length === 0 || !/^(```|#{1,4} |[-*] |\d+\. |> )/.test(lines[index]))) block.push(lines[index++]);
      inline(element, block.join('\n'));
    }
    fragment.append(element);
  }
  return fragment;
}
