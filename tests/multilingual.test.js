import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGES, CONCEPT_COUNT, fold, matchConcepts, HINT_I18N} from '../dist/core/concepts.js';
import {createSearchIndex,search} from '../dist/core/rank.js';
import {detectLanguage,tokenize,parseQuery} from '../dist/core/text.js';
const records=[
 {id:'secure-code-review',name:'Secure Code Review',description:'Review code security and vulnerabilities in repositories',keywords:['security audit','code review','threat modeling'],tags:['quality'],scope:'vault'},
 {id:'database-migration',name:'Database Migration',description:'Move schemas and data between databases',keywords:['sql database'],tags:['data'],scope:'native'},
 {id:'document-workflow',name:'Technical Documentation',description:'Write technical manuals and documentation',keywords:['docs'],tags:[],scope:'vault'},
];
const index=createSearchIndex(records);
const corpus={
 zh:'请做代码安全审查',en:'Please perform a security code review',hi:'कोड की सुरक्षा समीक्षा करें',de:'Sicherheitsprüfung des Codes durchführen',
 pt:'Faça uma revisão de segurança do código',ja:'コードのセキュリティレビューをお願いします',id:'Tinjauan keamanan kode sekarang',
 ru:'Проведи проверку безопасности кода',fr:'Faire un audit de sécurité du code',es:'Realice una revisión de seguridad del código',
 vi:'Hãy đánh giá bảo mật mã nguồn',nl:'Doe een beveiligingscontrole van code',tr:'Lütfen kod güvenlik incelemesi yap',
};
for(const [lang,phrase] of Object.entries(corpus)){
 test(`13-language relevance ${lang}`,()=>{
  const match=search(index,phrase,{topK:4});
  assert.equal(match[0]?.skill.id,'secure-code-review',JSON.stringify(match));
  assert.ok(match[0].coverage>0.6,JSON.stringify(match[0]));
  assert.ok(match[0].matched.length>=2,JSON.stringify(match[0]));
 });
}
test('Exactly 13 named languages with a localized hint string',()=>{assert.equal(LANGUAGES.length,13);assert.deepEqual([...Object.keys(HINT_I18N)].sort(),[...LANGUAGES].sort());assert.ok(CONCEPT_COUNT>=25);});
test('Cross-script Japanese and Hindi vowel marks stay intact',()=>{assert.equal(fold('が'), 'が');assert.equal(fold('सुरक्षा'),'सुरक्षा');assert.ok(tokenize('सुरक्षा समीक्षा').includes('सुरक्षा'));});
test('German Turkish Vietnamese latin accent fallback',()=>{assert.equal(fold('GÜVENLİĞİ'),'guvenligi');assert.equal(fold('BẢO MẬT'),'bao mat');assert.equal(fold('SICHERHEITSPRÜFUNG'),'sicherheitsprufung');});
test('Concept matcher does not match short aliases inside unrelated words',()=>{assert.equal(matchConcepts('digital').has('git'),false);assert.equal(matchConcepts('decoder').has('code'),false);});
test('Negative multilingual query excludes review skill',()=>assert.equal(search(index,'安全 -审查').some(r=>r.skill.id==='secure-code-review'),false));
test('Language detector script and Latin clues',()=>{for(const code of ['zh','ja','hi','ru','tr'])assert.equal(detectLanguage(corpus[code]),code);});
test('13-language keyword aliases classify cross-lingual documents',()=>{const x=createSearchIndex([{id:'de-security',name:'Sicherheitsprüfung',description:'Überprüfung des Codes',keywords:[],tags:[],scope:'vault'}]);assert.equal(search(x,'安全审查')[0]?.skill.id,'de-security');});
test('Parsing retains explicit positive/negative concepts',()=>{const p=parseQuery('代码 安全 -数据库');assert.ok(p.positiveConcepts.includes('security'));assert.ok(p.negativeConcepts.includes('database'));});
