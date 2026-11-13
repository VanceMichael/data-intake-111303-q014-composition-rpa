const app = document.querySelector('#app');
let state = await fetch('/portal/state').then(response => response.json());
const action = async value => {
  const response = await fetch('/portal/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  document.querySelector('#feedback').textContent = JSON.stringify(result, null, 2);
  return { ok: response.ok, value: result };
};
const feedback = '<pre id="feedback" aria-live="polite"></pre>';
app.innerHTML='<label>地点<input id="location"></label><label>容器<select id="container"><option value="">请选择</option><option value="瓶">瓶</option></select></label><label>单件数量<input id="quantity"></label><output id="total"></output><p id="validation"></p><button id="save">保存记录</button>'+feedback;
let composing=false;
let generation=0;
let calculatedGeneration=-1;
const location=document.querySelector('#location');
const quantity=document.querySelector('#quantity');
app.dataset.inputGeneration='0';app.dataset.calculatedGeneration='-1';
location.addEventListener('compositionstart',()=>{composing=true;location.dataset.composing='true';});
location.addEventListener('compositionend',()=>{composing=false;location.dataset.composing='false';});
for(const field of [location,quantity,document.querySelector('#container')])field.addEventListener('input',()=>{generation+=1;app.dataset.inputGeneration=String(generation);});
quantity.addEventListener('blur',()=>{
 if(!/^\d+$/.test(quantity.value)||Number(quantity.value)<=0){document.querySelector('#validation').textContent='数量必须为正整数';return;}
 quantity.value=String(Number(quantity.value));const current=generation;
 if(state.mode==='late')setTimeout(()=>{document.querySelector('#total').value='999';calculatedGeneration=current-1;app.dataset.calculatedGeneration=String(calculatedGeneration);},15);
 setTimeout(()=>{document.querySelector('#total').value=String(Number(quantity.value)*2);calculatedGeneration=current;app.dataset.calculatedGeneration=String(current);document.querySelector('#validation').textContent='校验通过';},70);
});
document.querySelector('#save').onclick=()=>action({action:'save',composing,inputGeneration:generation,calculatedGeneration,record:{location:location.value,container:document.querySelector('#container').value,quantity:quantity.value,total:Number(document.querySelector('#total').value)}});
