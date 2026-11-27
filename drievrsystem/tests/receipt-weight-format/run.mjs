import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installIDB } from './idb-shim.mjs';
installIDB();
const { calculateWeightTotal: weight, calculateRowNet: net, calculateReceiptTotals: totals, isSeparatorRow } = await import('./services/financialCalculator.js');
const { Money } = await import('./money.js');
const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ExcelService } = await import('./excelService.js');
const src = readFileSync('./_src/receipts.js', 'utf8');
const all = readFileSync('./_src/allReceipts.js', 'utf8');
const offices = readFileSync('./_src/offices.js', 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const columnsText = extract(src, 'const COL_DEFS = [', '\n// Snapshot data columns');
const cols = new Function(`${columnsText}; return COL_DEFS;`)();
const formCols = cols.filter(c => !c.noForm);
const expected = ['رقم الكارتة','التاريخ','اسم السائق','رقم المركبة','الوزن','عجز','اسم المكتب','التحميل','الجهة','النوع','نولون','عهدة','مكتب','إضافة','خصم','الصرف','الصافي','إجراءات'];
assert.deepEqual(formCols.map(c => c.label), expected);
assert(!cols.some(c => c.key === 'weight2' || c.key === 'weightTotal'));
assert.match(src, /<label[^>]*>رقم المركبة<\/label>\s*<div class="relative">\s*<input id="clientInput"/);
assert.equal(weight({weight:10, deficit:200, weight2:100}), 9.8);
assert.equal(weight({weight:10, deficit:0}), 10);
assert.equal(weight({weight:10, deficit:0.5}), 9.9995);
assert.equal(weight({weight:0, deficit:200}), -0.2);
const a = {weight:10, deficit:200, weight2:100, noloon:20, ohda:10, officeAmount:4, discount:3, add:5, sarf:2};
assert.equal(net(a), 182);
assert.equal(net({weight:1, deficit:0, noloon:1.235}), Money.round(1.235));
assert.equal(totals([a,{weight:1,noloon:1.235}, {_type:'separator',weight:100}]).total, 183.24);

// Extract real DOM construction helpers without executing browser boot.
function fn(name) {
 const start = src.indexOf(`function ${name}(`), b = src.indexOf('{', start);
 let level = 0;
 for (let i=b;i<src.length;i++) { if (src[i]==='{') level++; else if(src[i]==='}' && --level===0) return src.slice(start,i+1); }
 throw Error(name);
}
const ui = new Function('COL_DEFS','tFmt',`${fn('_buildArrowRowHTML')}\n${fn('renderTable')}\n${fn('_separatorRowInnerHTML')}\nreturn {arrow:_buildArrowRowHTML(), table:renderTable(), sep:_separatorRowInnerHTML(0)};`)(cols, Money.fmt);
assert.equal((ui.arrow.match(/<td\b/g)||[]).length, expected.length);
assert.equal((ui.table.match(/<th\b/g)||[]).length, expected.length);
assert.deepEqual([...ui.arrow.matchAll(/data-col-index="(\d+)"/g)].map(m=>+m[1]), formCols.map((c,i)=>c.key === '_actions' ? null : i).filter(x=>x!==null));
assert.equal([...ui.sep.matchAll(/colspan="(\d+)"/g)].reduce((n,m)=>n+Number(m[1]),0), expected.length);
assert.match(src, /const ENTER_NAV_ORDER = COL_DEFS[\s\S]*?!c\.noForm/);
assert.match(src, /data-col-index="\$\{i\}"/);
// Exercise fill-down by physical cell index for each reordered money field.
let lastEvent;
const makeInput = value => ({value, dataset:{}, classList:{contains:()=>false}, dispatchEvent:e=>{lastEvent=e.type;}});
const sourceInputs = formCols.map((_, i) => makeInput(String(i + 1)));
const targetInputs = formCols.map(() => makeInput(''));
const domRows = [sourceInputs,targetInputs].map(inputs => ({id:'', classList:{contains:()=>false}, querySelectorAll:()=>inputs.map(input=>({querySelector:()=>input}))}));
const fakeDoc = {querySelectorAll:()=>domRows};
const fill = new Function('document','Event','SEPARATOR_CLASS', `${fn('fillColumnDown')}; return fillColumnDown;`)(fakeDoc, class {constructor(type){this.type=type;}}, 'separator');
for (const key of ['officeAmount','add','discount','sarf']) {
  const index=formCols.findIndex(c=>c.key===key);
  fill(index); assert.equal(targetInputs[index].value, sourceInputs[index].value); assert.equal(lastEvent,'input');
}
// The actual keyboard handler derives Enter order from the form columns.
let keyHandler, focused='';
const active={classList:{contains:cls=>cls==='receipt-discount'}};
const keyboardRow={classList:{contains:()=>false},contains:()=>true,addEventListener:(_name,handler)=>{keyHandler=handler;},querySelector:selector=>({focus:()=>{focused=selector;},readOnly:false,disabled:false})};
const keyboardDocument={activeElement:active};
new Function('COL_DEFS','SEPARATOR_CLASS','document', `${fn('attachKeyboardNav')}; return attachKeyboardNav;`)(cols,'separator',keyboardDocument)(keyboardRow);
keyHandler({key:'Enter',preventDefault:()=>{}});
assert.equal(focused,'.receipt-sarf');
assert.match(src, /weightTotal\s*: calculateWeightTotal\(/);
assert.match(src, /row\.dataset\.weight2/);
assert.match(src, /netEl\.value = Money\.fmt\(calculateRowNet\(rowData\)\)/);
assert.match(offices, /const _calcWeight = calculateWeightTotal/);
const printColsText=extract(all, 'const _RECEIPT_PRINT_COLS = Object.freeze([', '\n/**\n * _receiptPrintGetCellValue');
const printCols=new Function(`${printColsText}; return _RECEIPT_PRINT_COLS;`)();
assert(!printCols.some(c=>['weight2','weightTotal'].includes(c.key)));
const at=printCols.findIndex(c=>c.key==='officeAmount');
assert.deepEqual(printCols.slice(at,at+4).map(c=>c.key), ['officeAmount','add','net','payment_status']);
assert.match(all, /return sum \+ calculateWeightTotal\(row\)/);
const snapshotValue = new Function('calculateWeightTotal', `${fn('getSnapshotCellRawValue')}; return getSnapshotCellRawValue;`)(weight);
assert.equal(snapshotValue({weight:10,deficit:200},{key:'weight'}),10);
assert.equal(snapshotValue({weight:10,deficit:200},{key:'deficit'}),200);
function allFn(name) {
 const start=all.indexOf(`function ${name}(`), b=all.indexOf('{',start); let level=0;
 for(let i=b;i<all.length;i++){if(all[i]==='{')level++;else if(all[i]==='}' && --level===0)return all.slice(start,i+1);}
 throw Error(name);
}
const printApi = new Function('_RECEIPT_PRINT_COLS','calculateWeightTotal',`${allFn('_receiptPrintGetCellValue')}\n${allFn('_receiptPrintResolveColumns')}\nreturn {value:_receiptPrintGetCellValue, resolve:_receiptPrintResolveColumns};`)(printCols,weight);
assert.equal(printApi.value({weight:10,deficit:200},'weight'),10);
assert.equal(printApi.value({weight:10,deficit:200},'deficit'),200);
const printed=printApi.resolve([{weight:10,sarf:2,add:5,discount:3}]).map(c=>c.key);
assert.deepEqual(printed.slice(printed.indexOf('officeAmount'),printed.indexOf('officeAmount')+4),['officeAmount','add','net','payment_status']);

// Actual Excel service with isolated in-memory SheetJS/FileReader doubles.
let captured, fileRows=[];
globalThis.window = { XLSX: {read:()=>({SheetNames:['S'],Sheets:{S:{}}}), utils:{
 sheet_to_json:()=>fileRows, json_to_sheet:(data,opts)=>(captured={data,headers:opts.header}), book_new:()=>({}), book_append_sheet:()=>{}
},writeFile:()=>{}}};
globalThis.File = class File { constructor(){this.name='test.xlsx';this.size=20;} };
globalThis.FileReader = class FileReader { readAsArrayBuffer(){this.onload({target:{result:new ArrayBuffer(0)}});} };
ExcelService.exportReceiptRows([{...a, _type:'data', net:net(a)}]);
assert.deepEqual(captured.headers, expected.filter(x=>x!=='إجراءات'));
assert.equal(captured.data[0]['الصافي'],182);
ExcelService.exportAllReceiptsRows([{record:{client_name:'مالك'},rows:[{...a,net:net(a),_type:'data'}]}]);
assert.deepEqual(captured.headers.slice(captured.headers.indexOf('الوزن'),captured.headers.indexOf('الوزن')+2), ['الوزن','عجز']);
const officeIndex=captured.headers.indexOf('مكتب');
assert.deepEqual(captured.headers.slice(officeIndex,officeIndex+4), ['مكتب','اضافة','خصم','الصرف']);
fileRows=[{'التاريخ':'2026-07-01','الوزن':10,'عجز':200,'نولون':20,'وزن م':0}];
let imported=await ExcelService.importReceiptRows(new File());
assert.equal(net(imported[0]),196);
assert.equal(imported[0].ohda, ''); // Missing inputs remain missing until the user fills them.
assert(!('weight2' in imported[0]));
fileRows=[{'الوزن':10,'وزن م':5}];
await assert.rejects(()=>ExcelService.importReceiptRows(new File()), /وزن م الملغى/);
fileRows=[{'الوزن':10,'وزن م':'غير معروف'}];
await assert.rejects(()=>ExcelService.importReceiptRows(new File()), /وزن م الملغى/);

// Actual IndexedDB-shim persistence and ledger lifecycle with new calculated net.
const U='test', owner='owner', vehicle='vehicle', office='office', rowId='row-1';
await DB.init();
await DB.add('vehicles',{id:vehicle,username:U,plate:'V1',owner_id:owner},{username:U});
await DB.add('offices',{id:office,username:U,name:'Office'},{username:U});
const row = {row_id:rowId, _type:'data', owner_id:owner, vehicle_id:vehicle, vehicle_plate:'V1', office:'Office', weight:10, weight2:7, deficit:200, weightTotal:weight(a), driver_price:a.noloon, advance:a.ohda, officeAmount:a.officeAmount, discount:a.discount, add:a.add, sarf:a.sarf, net:net(a)};
const payload={client_id:owner,client_type:'owner',client_name:'Client',receipt_date:'2026-07-01',total:totals([a]).total,rows:[row]};
const result=await FinancialService.createReceipt(U,payload);
let saved=await DB.getById('receipt_rows',rowId);
assert.equal(saved.deficit,200); assert.equal(saved.weightTotal,9.8); assert.equal(saved.weight2,7); assert.equal(saved.net,18200);
assert.equal((await DB.getById('receipts',result.receipt.id)).client_id,owner);
let ledger=await DB.getByIndex('vehicle_ledger','by_reference_id',rowId);
assert.equal(ledger.find(e=>e.reference_type==='receipt_row_vehicle_balance').amount,18200);
assert.equal(ledger.find(e=>e.reference_type==='receipt_row_company_charge').amount,18400);
await FinancialService.setReceiptRowPaymentStatus(U,rowId,'paid');
ledger=await DB.getByIndex('vehicle_ledger','by_reference_id',rowId);
assert.equal(ledger.find(e=>e.reference_type==='receipt_row_payment_company').amount,18400);
await FinancialService.setReceiptRowPaymentStatus(U,rowId,'unpaid');
const newRow={...row,deficit:500,weightTotal:weight({weight:10,deficit:500}),net:net({...a,deficit:500})};
await FinancialService.updateReceipt(U,result.receipt.id,{...payload,total:newRow.net,rows:[newRow]});
saved=await DB.getById('receipt_rows',rowId);
assert.equal(saved.deficit,500); assert.equal(saved.weightTotal,9.5); assert.equal(saved.net,17600); assert.equal(saved.weight2,7);
assert.equal((await DB.getById('receipts',result.receipt.id)).client_id,owner);
ledger=await DB.getByIndex('vehicle_ledger','by_reference_id',rowId);
assert.equal(ledger.filter(e=>e.reference_type==='receipt_row_vehicle_balance' && e.is_reversed===false)[0].amount,17600);
console.log('PASS receipt format, calculations, Excel, persistence and ledger regression');

// Execute the actual receipt edit loader, live calculation, collectors,
// normalization, update wrapper, repositories and FinancialService against
// a DOM double and IndexedDB shim. This is not a native browser test.
const { ReceiptReadRepository } = await import('./services/receiptReadRepository.js');
const editClient = {id:owner, type:'owner', name:'Client', label:'Client '};
const inputs = () => ({
  _value:'', dataset:{}, listeners:{},
  get value(){return this._value;}, set value(v){this._value=String(v);},
  addEventListener(type, handler){this.listeners[type]=handler;},
  dispatch(type){this.listeners[type]?.call(this,{type});},
});
const tbody = {
  rows:[],
  set innerHTML(_value){this.rows=[];},
  appendChild(row){this.rows.push(row);},
  querySelectorAll(){return this.rows;},
};
const elements = {receiptDate:inputs(),clientInput:inputs(),totalAmount:{textContent:''},rowCount:{textContent:''},receiptTableBody:tbody};
const editDocument = {
  getElementById(id){return elements[id] || null;},
  querySelector(){return null;},
  querySelectorAll(selector){return selector === '#receiptTableBody tr' ? tbody.rows : [];},
  createElement(tag){
    assert.equal(tag,'tr');
    const fields = new Map();
    return {
      id:'',dataset:{},classList:{contains:()=>false},
      set innerHTML(html){
        for (const match of html.matchAll(/<input\b[^>]*class="([^"]+)"/g)) {
          const name=match[1].split(/\s+/).find(c=>c.startsWith('receipt-'));
          if(name) fields.set(name,inputs());
        }
      },
      querySelector(selector){return fields.get(selector.replace(/^\./,'')) || null;},
    };
  },
};
const editHarness = new Function('document','Money','calculateWeightTotal','calculateRowNet','calculateReceiptTotals','FinancialService','ReceiptReadRepository','editClient','ExcelService','isSeparatorRow', `
  const ROW_TYPES = {DATA:'data', SEPARATOR:'separator'};
  const ROW_PAYMENT = {PENDING:'pending'};
  const SEPARATOR_CLASS = 'vehicle-separator-row';
  const ReceiptState = {editingReceiptId:null, isEditing:false};
  const _clientsCache = [editClient];
  let receiptRowCounter = 0;
  const OwnersModule = {getAllOwners:async()=>[editClient], getOwnerById:async(id)=>id===editClient.id ? editClient : null};
  const VehiclesModule = {resolveVehicle:async()=>({id:'vehicle',plate:'V1',owner_id:editClient.id})};
  const ClientRepository = {};
  const _currentUsername = ()=>'test';
  const _receiptLoadDriverOptions = async()=>{};
  const ensureReceiptArrowRow = ()=>{};
  const attachKeyboardNav = ()=>{};
  const attachInputRestrictions = ()=>{};
  const _syncCompanyLoadDetailsFromReceipt = async()=>{};
  ${columnsText}
  ${fn('_uuid')}
  ${fn('normalizeOptionalString')}
  ${fn('_validate')}
  ${fn('_normalizeRow')}
  ${fn('_normalize')}
  ${fn('_uiRowToPersistedShape')}
  ${fn('_persistedRowToUiShape')}
  ${fn('_buildServicePayload')}
  ${fn('_enterReceiptEditMode')}
  ${fn('_field')}
  ${fn('_num')}
  ${fn('_selectedClient')}
  ${fn('_buildRowHTML')}
  ${fn('_receiptRowDriverName')}
  ${fn('_handleReceiptExcelExport')}
  ${fn('attachRowCalculation')}
  ${fn('calculateTotals')}
  async ${fn('loadReceiptForEdit')}
  async ${fn('collectReceiptRows')}
  async ${fn('collectRawData')}
  async ${fn('update')}
  return {loadReceiptForEdit, collectRawData, update, exportForm:_handleReceiptExcelExport};
`)(editDocument,Money,weight,net,totals,FinancialService,ReceiptReadRepository,editClient,ExcelService,isSeparatorRow);
const beforeEdit = await DB.getById('receipts',result.receipt.id);
await DB.update('receipt_rows',rowId,{net:99900,driver_settlement_price:12345},{username:U});
await editHarness.loadReceiptForEdit(beforeEdit);
assert.equal(tbody.rows.length,1);
const loadedRow=tbody.rows[0];
assert.equal(loadedRow.dataset.weight2,'7');
assert.equal(loadedRow.querySelector('.receipt-weight2'),null);
assert.equal(loadedRow.querySelector('.receipt-weight-total'),null);
assert.equal(loadedRow.querySelector('.receipt-weight').value,'10');
assert.equal(loadedRow.querySelector('.receipt-deficit').value,'500');
assert.equal(loadedRow.querySelector('.receipt-net').value,'176.00');
assert.equal(elements.totalAmount.textContent,'176.00');
editHarness.exportForm();
assert.equal(captured.data[0]['الصافي'],176);
const loadedRaw = await editHarness.collectRawData();
assert.equal(loadedRaw.rows[0].net,176);
assert.equal(loadedRaw.total,176);
await editHarness.update(U,result.receipt.id,loadedRaw);
assert.equal((await DB.getById('receipt_rows',rowId)).net,17600);
assert.equal((await DB.getById('receipts',result.receipt.id)).total,17600);
loadedRow.querySelector('.receipt-deficit').value='200';
loadedRow.querySelector('.receipt-deficit').dispatch('input');
assert.equal(loadedRow.querySelector('.receipt-net').value,'182.00');
assert.equal(elements.totalAmount.textContent,'182.00');
const rawEdit=await editHarness.collectRawData();
assert.equal(rawEdit.client_id,owner);
assert.equal(rawEdit.rows[0].weight2,7);
assert.equal(rawEdit.rows[0].weightTotal,9.8);
assert.equal(rawEdit.rows[0].deficit,200);
assert.equal(rawEdit.rows[0].net,182);
assert.equal(rawEdit.total,182);
await editHarness.update(U,result.receipt.id,rawEdit);
const edited=await DB.getById('receipt_rows',rowId);
const editedHeader=await DB.getById('receipts',result.receipt.id);
assert.equal(edited.driver_settlement_price,12345);
assert.equal(rawEdit.rows[0].driver_settlement_price,123.45);
assert.equal(edited.weight2,7);
assert.equal(edited.weightTotal,9.8);
assert.equal(edited.deficit,200);
assert.equal(edited.net,18200);
assert.equal(editedHeader.total,18200);
assert.equal(editedHeader.client_id,beforeEdit.client_id);
assert.equal(editedHeader.client_type,beforeEdit.client_type);
console.log('PASS actual edit loader → live calculation → collectors → update wrapper → persistence (DOM/IndexedDB doubles)');

// Exercise each stored representation through real load, collect and update.
for (const preserved of [7, '7.5', null, '', 'not numeric']) {
  await DB.update('receipt_rows', rowId, {weight2:preserved}, {username:U});
  await editHarness.loadReceiptForEdit(await DB.getById('receipts',result.receipt.id));
  const current=tbody.rows[0];
  current.querySelector('.receipt-deficit').value='500';
  current.querySelector('.receipt-deficit').dispatch('input');
  const raw=await editHarness.collectRawData();
  assert.equal(raw.rows[0].weight2,preserved);
  assert.equal(raw.rows[0].weightTotal,9.5);
  assert.equal(raw.rows[0].net,176);
  raw.rows[0].weightTotal=999; // stale command value must not override normalization
  await editHarness.update(U,result.receipt.id,raw);
  const persisted=await DB.getById('receipt_rows',rowId);
  assert.equal(persisted.weight2,preserved);
  assert.equal(persisted.weightTotal,9.5);
  assert.equal(persisted.net,17600);
  assert.equal((await DB.getById('receipts',result.receipt.id)).client_id,owner);
}
for (const input of [undefined, null, '', 0, '0']) {
  assert.equal(weight({weight:input, deficit:200}),-0.2);
  assert.equal(weight({weight:input}),0);
}
assert.equal(weight({weight:'10',deficit:'200'}),9.8);
assert.equal(weight({weight:'10',deficit:null}),10);
console.log('PASS quantity representations and missing-value calculation');

// Use the production office and all-receipts summary functions with injected
// repository data, including absent inputs and conflicting stored values.
function sourceFn(source, name) {
 const start=source.indexOf(`function ${name}(`), b=source.indexOf('{',start); let level=0;
 if(start<0) throw Error(name);
 for(let i=b;i<source.length;i++){if(source[i]==='{')level++;else if(source[i]==='}' && --level===0)return source.slice(start,i+1);}
 throw Error(name);
}
const matrix = [
 [{deficit:200},-0.2], [{weight:null,deficit:200},-0.2],
 [{weight:'',deficit:200},-0.2], [{weight:0,deficit:200},-0.2],
 [{weight:'0',deficit:200},-0.2], [{weight:'10',deficit:'200'},9.8],
 [{weight:10},10], [{weight:10,deficit:0},10]
];
const summaryWeight = new Function('calculateWeightTotal',`${allFn('sumVisibleRowWeight')}; return sumVisibleRowWeight;`)(weight);
const projection = new Function('Money',`${allFn('_persistedRowToPageRow')}; return _persistedRowToPageRow;`)(Money);
let officeRows=[];
const officeSummary = new Function('Money','calculateWeightTotal','getRows',`
 const _calcWeight=calculateWeightTotal;
 const _requireUsername=()=>{};
 const getOffices=async()=>[{id:'office',name:'Office'}];
 const ReceiptRepository={getAll:async()=>[{id:'receipt'}]};
 const _resolveRange=()=>null;
 const _loadReceiptRowsProjection=async()=>new Map([['receipt',getRows()]]);
 ${sourceFn(offices,'_persistedRowToOfficeShape')}
 async ${sourceFn(offices,'getOfficeFinancialSummary')}
 return getOfficeFinancialSummary;
`)(Money,weight,()=>officeRows);
for (const [input, expectedWeight] of matrix) {
 const row={...input,office:'Office',weight2:999,weightTotal:999,weight_total:888};
 const page=projection(row);
 assert(!('weightTotal' in page) && !('weight_total' in page) && !('weight2' in page));
 assert.equal(summaryWeight([page]),expectedWeight);
 officeRows=[row];
 assert.equal((await officeSummary(U)).total_weight,expectedWeight);
 assert.equal(weight(row),expectedWeight);
 assert.equal(snapshotValue(page,{key:'weight'}), page.weight);
 assert.equal(printApi.value(page,'weight'),page.weight);
}
const bulkSummary = new Function('esc','fmtMoney',`${allFn('_buildReceiptsBulkSummary')}; return _buildReceiptsBulkSummary;`)(String,Money.fmt);
assert.match(bulkSummary({count:1,weight:-0.2,noloon:0,ohda:0}), /-0\.20/);
const matchRow = new Function('rowContains',`${allFn('rowMatchesReceiptFilters')};return rowMatchesReceiptFilters;`)((v,q)=>String(v??'').toLowerCase().includes(q));
assert.equal(matchRow({weight:73,weight2:81,weightTotal:92,deficit:64},{},{global:'92'}),false);
assert.equal(matchRow({weight:73,weight2:81,weightTotal:92,deficit:64},{},{global:'81'}),false);
assert.equal(matchRow({data:'driver',weight:73},{},{global:'driver'}),true);
for (const value of [undefined, null, '', '  ', 0, '0']) {
 fileRows=[{'التاريخ':'2026-07-01','الوزن':10,'وزن م':value}];
 assert.equal((await ExcelService.importReceiptRows(new File())).length,1);
}
fileRows=[{'الوزن':10,'وزن م':-1}];
await assert.rejects(()=>ExcelService.importReceiptRows(new File()), /وزن م الملغى/);
console.log('PASS summary matrix, office projection, print summary, filtering and legacy import');

// Real bundled SheetJS serialization/parsing; browser file I/O is simulated.
const {createRequire} = await import('node:module');
const XLSX = createRequire(import.meta.url)('./xlsx.full.min.js');
let bytes;
window.XLSX={...XLSX, writeFile:wb=>{bytes=XLSX.write(wb,{type:'array',bookType:'xlsx'});}};
globalThis.File=class File { constructor(data){this.name='test.xlsx';this.data=data;this.size=data.byteLength;} };
globalThis.FileReader=class FileReader {readAsArrayBuffer(file){this.onload({target:{result:file.data}});}};
ExcelService.exportReceiptRows([{...a,_type:'data',date:'2026-07-01',net:net(a)}]);
let workbook=XLSX.read(bytes,{type:'array'});
let workbookRows=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
assert.equal(workbookRows[0]['الصافي'],182);
assert.deepEqual(Object.keys(workbookRows[0]).slice(Object.keys(workbookRows[0]).indexOf('الوزن'),Object.keys(workbookRows[0]).indexOf('الوزن')+2), ['الوزن','عجز']);
const reimport=await ExcelService.importReceiptRows(new File(bytes));
assert.equal(net(reimport[0]),182);
ExcelService.exportAllReceiptsRows([{record:{client_name:'Client'},rows:[{...a,net:net(a)}]}]);
workbook=XLSX.read(bytes,{type:'array'});
workbookRows=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
assert.equal(workbookRows[0]['الصافي'],182);
assert.deepEqual(Object.keys(workbookRows[0]).slice(Object.keys(workbookRows[0]).indexOf('الوزن'),Object.keys(workbookRows[0]).indexOf('الوزن')+2), ['الوزن','عجز']);
const legacyBook=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(legacyBook,XLSX.utils.json_to_sheet([{'التاريخ':'2026-07-01','الوزن':10,'وزن م':3}]),'S');
await assert.rejects(()=>ExcelService.importReceiptRows(new File(XLSX.write(legacyBook,{type:'array',bookType:'xlsx'}))), /وزن م الملغى/);
console.log('PASS real SheetJS XLSX serialization, exports and import (file I/O simulated)');

const duplicateBook=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(duplicateBook,XLSX.utils.aoa_to_sheet([['التاريخ','الوزن','وزن م','وزن م'],['2026-07-01',10,0,5]]),'S');
await assert.rejects(()=>ExcelService.importReceiptRows(new File(XLSX.write(duplicateBook,{type:'array',bookType:'xlsx'}))), /وزن م الملغى/);
const booleanBook=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(booleanBook,XLSX.utils.aoa_to_sheet([['التاريخ','الوزن','وزن م'],['2026-07-01',10,false]]),'S');
await assert.rejects(()=>ExcelService.importReceiptRows(new File(XLSX.write(booleanBook,{type:'array',bookType:'xlsx'}))), /وزن م الملغى/);
console.log('PASS duplicate legacy headers and invalid boolean cells');

const errorBook=XLSX.utils.book_new();
const errorSheet=XLSX.utils.aoa_to_sheet([['التاريخ','الوزن','وزن م'],['2026-07-01',10,0]]);
errorSheet.C2={t:'e',v:7};
XLSX.utils.book_append_sheet(errorBook,errorSheet,'S');
await assert.rejects(()=>ExcelService.importReceiptRows(new File(XLSX.write(errorBook,{type:'array',bookType:'xlsx'}))), /وزن م الملغى/);
console.log('PASS legacy Excel error cell rejection');

// Receipt service commands reject incomplete calculation inputs
// and ignore all caller-supplied computed amounts.
const serviceRow={...row,row_id:'boundary-row',weightTotal:999,net:999};
const servicePayload={...payload,total:999,rows:[serviceRow]};
const direct=await FinancialService.createReceipt(U,servicePayload);
let directRow=await DB.getById('receipt_rows','boundary-row');
assert.equal(directRow.weightTotal,9.8);
assert.equal(directRow.net,18200);
assert.equal((await DB.getById('receipts',direct.receipt.id)).total,18200);
let directLedger=await DB.getByIndex('vehicle_ledger','by_reference_id','boundary-row');
assert.equal(directLedger.find(e=>e.reference_type==='receipt_row_vehicle_balance'&&!e.is_reversed).amount,18200);
assert.equal(directLedger.find(e=>e.reference_type==='receipt_row_company_charge'&&!e.is_reversed).amount,18400);
await FinancialService.updateReceipt(U,direct.receipt.id,{...servicePayload,total:1,rows:[{...serviceRow,deficit:500,net:999,weightTotal:999}]});
directRow=await DB.getById('receipt_rows','boundary-row');
assert.equal(directRow.weightTotal,9.5);
assert.equal(directRow.net,17600);
assert.equal((await DB.getById('receipts',direct.receipt.id)).total,17600);
directLedger=await DB.getByIndex('vehicle_ledger','by_reference_id','boundary-row');
assert.equal(directLedger.find(e=>e.reference_type==='receipt_row_vehicle_balance'&&!e.is_reversed).amount,17600);
assert.equal(directLedger.find(e=>e.reference_type==='receipt_row_company_charge'&&!e.is_reversed).amount,17800);
assert.equal((await DB.getById('receipts',direct.receipt.id)).client_id,owner);
const {weight:removedInput,...incomplete}=serviceRow;
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[incomplete]}), /receipt calculation input weight is required/);
console.log('PASS service input-derived receipt and ledger amounts');

// Validate every duplicate, including whitespace before a generated suffix.
for (const headers of [['وزن م ','وزن م '], ['  وزن م','  وزن م'], ['وزن م_1',' وزن م _2 ']]) {
 for (let target=0;target<headers.length;target++) {
  for (const invalid of [5,-1,'invalid',false]) {
   const cells=[0,0]; cells[target]=invalid;
   const wb=XLSX.utils.book_new();
   XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['التاريخ','الوزن',...headers],['2026-07-01',10,...cells]]),'S');
   await assert.rejects(()=>ExcelService.importReceiptRows(new File(XLSX.write(wb,{type:'array',bookType:'xlsx'}))),/وزن م الملغى/);
  }
 }
 const wb=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['التاريخ','الوزن',...headers],['2026-07-01',10,0,'']]),'S');
 assert.equal((await ExcelService.importReceiptRows(new File(XLSX.write(wb,{type:'array',bookType:'xlsx'})))).length,1);
}
console.log('PASS transformed and whitespace duplicate legacy headers');

for (let target=0;target<2;target++) {
 const wb=XLSX.utils.book_new();
 const ws=XLSX.utils.aoa_to_sheet([['التاريخ','الوزن','وزن م ','وزن م '],['2026-07-01',10,0,0]]);
 ws[target===0?'C2':'D2']={t:'e',v:7};
 XLSX.utils.book_append_sheet(wb,ws,'S');
 await assert.rejects(()=>ExcelService.importReceiptRows(new File(XLSX.write(wb,{type:'array',bookType:'xlsx'}))),/وزن م الملغى/);
}
const multiRow={...serviceRow,row_id:'boundary-row-2',weight:1,deficit:0,driver_price:10,advance:0,officeAmount:0,discount:0,add:0,sarf:0};
const multi=await FinancialService.createReceipt(U,{...servicePayload,total:999,rows:[{...serviceRow,row_id:'boundary-row-3'},multiRow]});
assert.equal((await DB.getById('receipts',multi.receipt.id)).total,19200);
assert.equal((await DB.getById('receipt_rows','boundary-row-2')).net,1000);
console.log('PASS duplicate error cells and multi-row service totals');

// Cents are the stored precision of every monetary input. Calculation uses
// those same rounded values before saving, while quantities retain precision.
const precisionRow={...serviceRow,row_id:'precision-row',weight:10.1234,deficit:123.45,
 driver_price:1.235,advance:0.125,officeAmount:0.135,discount:0.145,add:1.225,sarf:0.155,net:999,weightTotal:999};
const precisionReceipt=await FinancialService.createReceipt(U,{...servicePayload,rows:[precisionRow],total:999});
const precisionSaved=await DB.getById('receipt_rows','precision-row');
const precisionUi={weight:precisionSaved.weight,deficit:precisionSaved.deficit,
 noloon:Money.toDecimal(precisionSaved.driver_price),ohda:Money.toDecimal(precisionSaved.advance),
 officeAmount:Money.toDecimal(precisionSaved.officeAmount),discount:Money.toDecimal(precisionSaved.discount),
 add:Money.toDecimal(precisionSaved.add),sarf:Money.toDecimal(precisionSaved.sarf)};
assert.equal(net({...precisionRow,noloon:precisionRow.driver_price,ohda:precisionRow.advance}),net(precisionUi));
assert.equal(precisionSaved.net,Money.toCents(net(precisionUi)));
assert.equal((await DB.getById('receipts',precisionReceipt.receipt.id)).total,precisionSaved.net);
assert.equal((await DB.getByIndex('vehicle_ledger','by_reference_id','precision-row')).find(e=>e.reference_type==='receipt_row_vehicle_balance'&&!e.is_reversed).amount,precisionSaved.net);
await editHarness.loadReceiptForEdit(await DB.getById('receipts',precisionReceipt.receipt.id));
assert.equal(Number(tbody.rows[0].querySelector('.receipt-net').value),net(precisionUi));
assert.equal(Number(elements.totalAmount.textContent),net(precisionUi));
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[{row_id:'amount-only',owner_id:owner,vehicle_id:vehicle,net:100}]}), /receipt calculation input weight is required/);
for (const invalid of ['',null,undefined,'x',Infinity,false]) {
 await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[{...serviceRow,driver_price:invalid}]}), /receipt calculation input driver_price is required/);
}
console.log('PASS cents precision, reopen and amount-only rejection');
for (const key of ['weight','deficit','driver_price','advance','officeAmount','discount','add','sarf']) {
 const missing={...serviceRow}; delete missing[key];
 await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[missing]}),new RegExp(`receipt calculation input ${key} is required`));
 await assert.rejects(()=>FinancialService.updateReceipt(U,result.receipt.id,{...servicePayload,rows:[missing]}),new RegExp(`receipt calculation input ${key} is required`));
}
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[{...serviceRow,driver_price:1e200}]}), /safe monetary precision/);
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[{...serviceRow,weight:1e200}]}), /safe precision/);
for (const value of [1.005,1.235,-1.005,-1.235,1234567.895]) {
 assert.equal(Money.toCents(Money.round(value)),Money.toCents(value));
}
console.log('PASS create/update required fields and precision bounds');

// A legacy type-only separator is recognized only without an explicit data marker;
// an editable cargo type on an explicitly marked data row is not a separator.
for (const marker of [{_type:'separator'}, {type:'separator'}, {row_type:'separator'}]) {
  assert.equal(isSeparatorRow(marker), true);
  assert.equal(weight({...a,...marker}), 0);
  assert.equal(net({...a,...marker}), 0);
}
const editableType={...a,_type:'data',type:'separator'};
assert.equal(isSeparatorRow(editableType),false);
assert.equal(weight(editableType),9.8);
assert.equal(net(editableType),182);
assert.equal(totals([editableType,{...a,_type:'separator'},{...a,type:'separator'},{...a,row_type:'separator'}]).total,182);
const mixed = await FinancialService.createReceipt(U,{...servicePayload,rows:[
 {...serviceRow,row_id:'mixed-data',_type:'data',type:'separator'},
 {_type:'separator'}, {type:'separator'}, {row_type:'separator'},
]});
assert.equal((await DB.getById('receipts',mixed.receipt.id)).total,18200);
assert.equal((await DB.getById('receipt_rows','mixed-data')).weightTotal,9.8);
assert.equal((await DB.getById('receipt_rows','mixed-data')).net,18200);
assert.equal((await ReceiptReadRepository.getReceiptRowsByReceipt(mixed.receipt.id)).length,1);
await FinancialService.updateReceipt(U,mixed.receipt.id,{...servicePayload,rows:[
 {...serviceRow,row_id:'mixed-data',_type:'data',type:'separator',deficit:500},
 {_type:'separator'}, {type:'separator'}, {row_type:'separator'},
]});
assert.equal((await DB.getById('receipt_rows','mixed-data')).net,17600);
assert.equal((await DB.getById('receipts',mixed.receipt.id)).total,17600);
console.log('PASS separator aliases, editable cargo type, mixed create and update');

// Actual form export plus SheetJS round trip must not turn blanks or bad data
// into a numeric zero. Save validation is exercised on the imported payload.
await editHarness.loadReceiptForEdit(await DB.getById('receipts',result.receipt.id));
const exportRow=tbody.rows[0];
exportRow.querySelector('.receipt-date').value='2026-07-01';
const originalQuery=exportRow.querySelector;
const validateImport=new Function(`${fn('_validateImportedCalculationInputs')}; return _validateImportedCalculationInputs;`)();
for (const [key,cls,header,serviceKey] of [
  ['weight','weight','الوزن','weight'], ['deficit','deficit','عجز','deficit'],
  ['noloon','noloon','نولون','driver_price'], ['ohda','ohda','عهدة','advance'],
  ['officeAmount','office-amount','مكتب','officeAmount'], ['discount','discount','خصم','discount'],
  ['add','add','إضافة','add'], ['sarf','sarf','الصرف','sarf'],
]) {
  const selector=`.receipt-${cls}`;
  const input=originalQuery.call(exportRow,selector);
  const originalValue=input.value;
  for (const [kind,value,expected] of [['blank','', ''],['invalid','bad-number','bad-number'],['zero','0',0],['missing',null,'']]) {
    if(kind==='missing') exportRow.querySelector=name=>name===selector?null:originalQuery.call(exportRow,name);
    else input.value=value;
    editHarness.exportForm();
    const book=XLSX.read(bytes,{type:'array'});
    const exported=XLSX.utils.sheet_to_json(book.Sheets['كارتات'],{defval:''})[0];
    assert.equal(exported[header],expected,`${key}: ${kind} export`);
    const importedRow=(await ExcelService.importReceiptRows(new File(bytes)))[0];
    assert.equal(importedRow[key],expected,`${key}: ${kind} import`);
    if(kind==='invalid') assert.throws(()=>validateImport([importedRow]),/غير رقمية/);
    else assert.doesNotThrow(()=>validateImport([importedRow]));
    const commandRow={...serviceRow,...importedRow,row_id:`export-${key}-${kind}`,
      driver_price:importedRow.noloon,advance:importedRow.ohda};
    if(kind==='zero') {
      if(key==='weight' || key==='noloon') commandRow.add=300;
      const accepted=await FinancialService.createReceipt(U,{...servicePayload,rows:[commandRow]});
      assert.equal((await DB.getById('receipt_rows',commandRow.row_id))[serviceKey],0);
      assert.ok(accepted.receipt.id);
    } else {
      await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[commandRow]}),
        new RegExp(`receipt calculation input ${serviceKey} is required`));
    }
    exportRow.querySelector=originalQuery;
  }
  input.value=originalValue;
}
console.log('PASS real XLSX blank, missing, invalid and zero export/import/save');

// Reject only amounts that cannot round-trip through the current decimal/cents
// representation, rather than imposing a new arbitrary monetary maximum.
const unstable=41123168407811.195;
assert.notEqual(Money.toCents(unstable),Money.toCents(Money.round(unstable)));
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[{...serviceRow,row_id:'unstable',driver_price:unstable}]}),/cannot be represented consistently/);
assert.equal(await DB.getById('receipt_rows','unstable'),null);
const unsafeSum={...serviceRow,row_id:'unsafe-company-sum',weight:2,deficit:0,
  driver_price:45035996273705,advance:0,officeAmount:0,discount:0,add:0,sarf:1};
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[unsafeSum]}),/company amount exceeds safe precision/);
assert.equal(await DB.getById('receipt_rows','unsafe-company-sum'),null);
assert.equal((await DB.getByIndex('vehicle_ledger','by_reference_id','unsafe-company-sum')).length,0);
const beforeUnsafeUpdate=await DB.getById('receipt_rows','boundary-row');
await assert.rejects(()=>FinancialService.updateReceipt(U,direct.receipt.id,{...servicePayload,
  rows:[{...unsafeSum,row_id:'boundary-row'}]}),/company amount exceeds safe precision/);
assert.deepEqual(await DB.getById('receipt_rows','boundary-row'),beforeUnsafeUpdate);
// Each row amount is representable, but their sum cannot be converted to a
// decimal and back without changing a cent.
const totalA=45035996273700, totalB=45035996273700.01;
assert.equal(Money.toCents(totalA),4503599627370000);
assert.equal(Money.toCents(totalB),4503599627370001);
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[
 {...serviceRow,row_id:'unstable-total-a',office:null,weight:1,deficit:0,driver_price:totalA,advance:0,officeAmount:0,discount:0,add:0,sarf:0},
 {...serviceRow,row_id:'unstable-total-b',office:null,weight:1,deficit:0,driver_price:totalB,advance:0,officeAmount:0,discount:0,add:0,sarf:0},
]}),/receipt total exceeds safe precision/);
assert.equal(await DB.getById('receipt_rows','unstable-total-a'),null);
// A safe integer company sum can still lose a cent when decimalized.
const unstableCompany={...serviceRow,row_id:'unstable-company',weight:2,deficit:0,
  driver_price:45035996273700.05,advance:0,officeAmount:0,discount:0,add:0,sarf:45035996273700};
await assert.rejects(()=>FinancialService.createReceipt(U,{...servicePayload,rows:[unstableCompany]}),/company amount exceeds safe precision/);
assert.equal(await DB.getById('receipt_rows','unstable-company'),null);
const noOffice={...unsafeSum,row_id:'unsafe-payment',office:null};
await FinancialService.createReceipt(U,{...servicePayload,rows:[noOffice]});
await DB.update('receipt_rows','unsafe-payment',{office:'Office'},{username:U});
await assert.rejects(()=>FinancialService.setReceiptRowPaymentStatus(U,'unsafe-payment','paid'),/company amount exceeds safe precision/);
assert.equal((await DB.getById('receipt_rows','unsafe-payment')).payment_status,'unpaid');
assert.equal((await DB.getByIndex('vehicle_ledger','by_reference_id','unsafe-payment')).filter(e=>e.reference_type==='receipt_row_payment_company').length,0);
console.log('PASS unstable cent representation and unsafe company ledger sums');

// Equal addition and sarf are neutral, including at a half-cent rounding edge.
// The existing JS rounding policy and the calculation order for non-equal
// adjustments remain unchanged.
const realistic={_type:'data',weight:10,deficit:5,noloon:11,ohda:0,officeAmount:0,discount:0,add:1000,sarf:1000};
const withoutAdjustments={...realistic,add:0,sarf:0};
assert.equal(net(withoutAdjustments),109.95);
assert.equal(net(realistic),net(withoutAdjustments));
const unequal={...realistic,add:1000,sarf:999.99};
assert.equal(net(unequal),Money.round((10-5/1000)*11+1000-999.99));
const neutralRow={...serviceRow,row_id:'neutral-adjustment',weight:10,deficit:5,driver_price:11,
 advance:0,officeAmount:0,discount:0,add:1000,sarf:1000};
const neutral=await FinancialService.createReceipt(U,{...servicePayload,rows:[neutralRow]});
const neutralSaved=await DB.getById('receipt_rows','neutral-adjustment');
assert.equal(neutralSaved.net,10995);
assert.equal((await DB.getById('receipts',neutral.receipt.id)).total,10995);
const neutralLedger=await DB.getByIndex('vehicle_ledger','by_reference_id','neutral-adjustment');
assert.equal(neutralLedger.find(e=>e.reference_type==='receipt_row_vehicle_balance'&&!e.is_reversed).amount,10995);
assert.equal(neutralLedger.find(e=>e.reference_type==='receipt_row_company_charge'&&!e.is_reversed).amount,110995);
await editHarness.loadReceiptForEdit(await DB.getById('receipts',neutral.receipt.id));
assert.equal(Number(tbody.rows[0].querySelector('.receipt-net').value),109.95);
assert.equal(Number(elements.totalAmount.textContent),109.95);
console.log('PASS realistic equal-adjustment half-cent calculation, persistence, ledger and reopen');
