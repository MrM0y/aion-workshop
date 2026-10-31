/** Update calculated markup without replacing the field the user is editing. */
export function patchContent(host,html){
  const template=host.ownerDocument.createElement('div');template.innerHTML=html;
  const active=host.ownerDocument.activeElement;
  const key=node=>node.nodeType!==1?node.nodeName:node.getAttribute('data-ui-key')||node.id||node.getAttribute('data-pp-sale')||node.getAttribute('data-pp-unit')||node.nodeName+':'+(node.getAttribute('class')||'').split(' ')[0];
  function patch(parent,next){
    const old=[...parent.childNodes],used=new Set();let cursor=parent.firstChild;
    for(const wanted of [...next.childNodes]){
      const current=old.find(node=>!used.has(node)&&node.nodeType===wanted.nodeType&&node.nodeName===wanted.nodeName&&key(node)===key(wanted));
      if(!current){parent.insertBefore(wanted,cursor);continue;}
      used.add(current);
      if(current!==cursor&&!current.contains?.(active))parent.insertBefore(current,cursor);
      if(current.nodeType===1){
        for(const attr of [...current.attributes])if(!wanted.hasAttribute(attr.name)&&!(attr.name==='open'&&current.tagName==='DETAILS'))current.removeAttribute(attr.name);
        for(const attr of [...wanted.attributes])if(!(current===active&&attr.name==='value')&&current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
        if(current.tagName==='INPUT'&&current!==active){current.value=wanted.value;current.checked=wanted.checked;}
        if(!current.hasAttribute('data-live-preserve'))patch(current,wanted);
      }else if(current.nodeValue!==wanted.nodeValue)current.nodeValue=wanted.nodeValue;
      cursor=current.nextSibling;
    }
    for(const node of old)if(!used.has(node)&&!node.contains?.(active))node.remove();
  }
  patch(host,template);
}

export function gradeClass(grade){return ['Common','Rare','Legend','Unique','Epic','Mythic'].includes(grade)?'item-grade grade-'+grade.toLowerCase():'';}
