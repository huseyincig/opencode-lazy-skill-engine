import { fold, LANGUAGES, matchConcepts } from './concepts.js';
export { fold };
const stop=new Set(('a an and are as at be by can do for from has have how i in is it its of on or our please some that the their this to use using want what when where which with would you your perform full complete ' +
  've veya ile icin bir bu su olarak nasil neden hangi daha bana ben bende gerekiyor simdi gore hangi yap butun tum de da mi mı mu mü ' +
  'der die das den dem des ein eine und fur mit bei zu von ist bitte durchfuhren ' +
  'de da do dos das para por com em o os um uma e que como favor ' +
  'le la les de des du dans pour avec une un et sur que est ' +
  'el la los las de del por para con que un una y en ' +
  'dan dan di ke untuk pada yang ini itu dengan adalah ' +
  'van voor met het een en op om bij dat die in doe ' +
  'cho cua va tren voi mot cac la duoc hay ' +
  '请 做 的 在 和 为 用 について を で です これ の お願い お願いし お願いします ます する して ください ' +
  'और का की के में पर से यह लिए करें को ' +
  'и в на из по для что это как сделать мне ' +
  'a e o u la ve ya mi do da de lutfen ' ).split(/\s+/).map(fold));
const segmenters=new Map();
const INDIC=/[\p{Script=Devanagari}]/u;
const HAN=/[\p{Script=Han}]/u;
const JAPANESE=/[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CYRILLIC=/[\p{Script=Cyrillic}]/u;
const WORD=/[\p{L}\p{M}\p{N}]/u;

export function detectLanguage(text, preferred='auto') {
  if(LANGUAGES.includes(preferred))return preferred;
  const s=fold(text);
  if(JAPANESE.test(s))return 'ja';
  if(HAN.test(s))return 'zh';
  if(INDIC.test(s))return 'hi';
  if(CYRILLIC.test(s))return 'ru';
  const clues={
    de:['und','sicherheit','prüfung','fehler','des','bitte','überprüfung'],
    pt:['segurança','revisão','para','código','implementar','depuração','não'],
    id:['keamanan','kode','pengujian','tinjauan','dengan','yang','untuk'],
    fr:['sécurité','révision','vérifier','avec','des','les','du','pour'],
    es:['seguridad','revisión','código','pruebas','del','con','para'],
    vi:['bảo mật','kiểm tra','kiểm thử','mã nguồn','giúp','của','cho'],
    nl:['beveiliging','controle','fouten','onderzoek','van','voor','het'],
    tr:['güvenlik','inceleme','hata','kod','için','lütfen','yapılandırma'],
  };
  const raw=String(text).replace(/İ/g,'i').normalize('NFC').toLowerCase();let best='en',score=0;
  for(const [lang,terms] of Object.entries(clues)){
    let hits=0;
    for(const term of terms){
      const key=term.toLowerCase();
      let from=0;
      while(from<=raw.length-key.length){
        const at=raw.indexOf(key,from);
        if(at===-1)break;
        if((at===0||!WORD.test(raw[at-1])) && (at+key.length===raw.length || !WORD.test(raw[at+key.length]))){hits+=term.includes(' ')?3:2;break;}
        from=at+1;
      }
    }
    if(hits>score){score=hits;best=lang;}
  }
  return best;
}
const TURKISH_SUFFIXES=['larindan','lerinden','lariyla','leriyle','indaki','indeki','masi','mesi','sini','sina','sine','deki','daki','mak','mek','dan','den','tan','ten','nin','nun','lar','ler','lik','luk','ci','yi','yu','si','in','un'];
const PURE_LATIN=/^[a-z]+$/;
export function tokenize(text, keepStop=false, language='auto') {
  const pre=String(text??'').replace(/([\p{Ll}\p{N}]\p{M}*)(\p{Lu})/gu,'$1 $2').replace(/(\p{Lu}+\p{M}*)(\p{Lu}\p{Ll})/gu,'$1 $2');
  const s=fold(pre);if(!s)return [];
  const out=[];
  // Fast Unicode-regex path for Latin, Cyrillic, and Indic scripts. Indic combining
  // marks remain in each word; expensive dictionary segmentation is CJK-only.
  if(!HAN.test(s)&&!JAPANESE.test(s)){
    for(const m of s.matchAll(/[\p{L}\p{M}\p{N}]+/gu))out.push(m[0]);
  }else{
    const lang=(language==='zh'||language==='ja')?language:detectLanguage(s,'auto');let seg=segmenters.get(lang);
    if(!seg&&typeof Intl.Segmenter==='function'){seg=new Intl.Segmenter(lang,{granularity:'word'});segmenters.set(lang,seg);}
    if(seg){
      for(const entry of seg.segment(s)){
        if(!entry.isWordLike)continue;
        for(const match of entry.segment.matchAll(/[\p{L}\p{M}\p{N}]+/gu))out.push(match[0]);
      }
    }else{
      for(const m of s.matchAll(/[\p{L}\p{M}\p{N}]+/gu)){
        const word=m[0];if(HAN.test(word)&&[...word].length>2){const cs=[...word];for(let i=0;i<cs.length-1;i++)out.push(cs.slice(i,i+2).join(''));}
        else out.push(word);
      }
    }
  }
  return out.filter(t=>(t.length>1||HAN.test(t)) && (keepStop||!stop.has(t))).slice(0,150);
}
export function variants(term) {
  const word=fold(term);
  if(word.length<5||!PURE_LATIN.test(word))return [word].filter(Boolean);
  const out=[word];
  for(const suffix of TURKISH_SUFFIXES){
    if(word.endsWith(suffix)){
      const stem=word.slice(0,word.length-suffix.length);
      if(stem.length>=3&&!out.includes(stem))out.push(stem);
      if((suffix==='masi'||suffix==='mesi')&&word.length-2>=3){
        const verbal=word.slice(0,-2);if(!out.includes(verbal))out.push(verbal);
      }
      break;
    }
  }
  if(word.endsWith('ies')&&word.length-2>=3){const s=`${word.slice(0,-3)}y`;if(!out.includes(s))out.push(s);}
  else if(word.endsWith('ing')&&word.length-3>=3){const s=word.slice(0,-3);if(!out.includes(s))out.push(s);}
  else if(word.endsWith('ed')&&word.length-2>=3){const s=word.slice(0,-2);if(!out.includes(s))out.push(s);}
  else if(word.endsWith('es')&&word.length-2>=3){const s=word.slice(0,-2);if(!out.includes(s))out.push(s);}
  else if(word.endsWith('s')&&!word.endsWith('ss')&&word.length-1>=3){const s=word.slice(0,-1);if(!out.includes(s))out.push(s);}
  return out;
}
export function parseQuery(query, maxChars=12000) {
  if(typeof query!=='string')throw new TypeError('query must be a string');
  const input=query.slice(0,maxChars);
  const positive=[],negative=[],phrases=[],posRaw=[],negRaw=[];
  const re=/(-?)(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+))/g;
  for(const m of input.matchAll(re)){
    const raw=m[2]??m[3]??m[4];if(!raw||raw==='*')continue;
    const neg=m[1]==='-';const phrase=m[2]!==undefined||m[3]!==undefined;
    const tokens=tokenize(raw);
    (neg?negRaw:posRaw).push(raw);
    if(phrase&&!neg)phrases.push(fold(raw));
    for(const t of tokens)(neg?negative:positive).push(t);
  }
  return {positive:[...new Set(positive)].slice(0,24),negative:[...new Set(negative)].slice(0,12),
    positiveRaw:posRaw.join(' '),negativeRaw:negRaw.join(' '),phrases:phrases.slice(0,6),
    positiveConcepts:[...matchConcepts(posRaw.join(' ')).keys()].slice(0,20),
    negativeConcepts:[...matchConcepts(negRaw.join(' ')).keys()].slice(0,12),
    explicit:/(?:@|\bskill\s*[:=]\s*)([a-z0-9][a-z0-9-]{0,63})/i.exec(input)?.[1]??null};
}
export function xmlEscape(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
export function clipped(s,n){const text=String(s??'').replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();return text.length>n?`${text.slice(0,n-1)}…`:text;}
export function editDistanceWithinOne(a,b){
  const ac=[...a],bc=[...b];if(Math.abs(ac.length-bc.length)>1)return false;
  if(a===b)return true;let i=0,j=0,edits=0;
  while(i<ac.length&&j<bc.length){if(ac[i]===bc[j]){i++;j++;continue;}if(++edits>1)return false;if(ac.length>=bc.length)i++;if(ac.length<=bc.length)j++;}
  return edits+(ac.length-i)+(bc.length-j)<=1;
}
