import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {patchContent,gradeClass} from '../public/live-dom.js';

test('calculated markup preserves the edited field, open disclosures and manual lot editor',()=>{
  const {document}=parseHTML('<main></main>'),host=document.querySelector('main');
  const markup=value=>`<section><label data-ui-key="sale"><input data-pp-sale="item" value="${value}"></label><details><summary>Budget</summary></details><div class="editor" data-live-preserve></div><strong>${value}</strong></section>`;
  patchContent(host,markup(10));
  const input=host.querySelector('input');input.value='1000';
  Object.defineProperty(document,'activeElement',{configurable:true,value:input});
  host.querySelector('details').setAttribute('open','');
  host.querySelector('.editor').innerHTML='<input value="unsaved lot">';
  patchContent(host,markup(20));
  assert.equal(host.querySelector('input'),input);assert.equal(input.value,'1000');
  assert.ok(host.querySelector('details').hasAttribute('open'));
  assert.equal(host.querySelector('.editor input').value,'unsaved lot');
  assert.equal(host.querySelector('strong').textContent,'20');
  Object.defineProperty(document,'activeElement',{value:null});
  patchContent(host,markup(30));assert.equal(input.value,'30');
});

test('item tones use catalog quality and ignore unsupported tokens',()=>{
  for(const grade of ['Common','Rare','Legend','Unique','Epic'])assert.equal(gradeClass(grade),'item-grade grade-'+grade.toLowerCase());
  assert.equal(gradeClass(null),'');assert.equal(gradeClass('injected" class'),'');
});
