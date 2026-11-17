import { fold, tokenize, parseQuery, editDistanceWithinOne } from './text.js';
import { matchConcepts } from './concepts.js';
import { negativeTriggerMatch } from './selection.js';

const FIELDS=['id','name','keywords','aliases','tags','triggers','description'];
const C='~'; // Explicit concept namespace: cannot collide with natural metadata tokens.
const isEastAsian=s=>/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s);
const conceptToken=t=>C+t;
function features(text){
  const words=tokenize(text,true);
  for(const concept of matchConcepts(text).keys()) words.push(conceptToken(concept));
  return words;
}
/** Sparse inverted postings: candidate evaluation costs depend on matching docs, not total skill count. */
export function createSearchIndex(skills, weights={}) {
  const docs=[], postings=new Map(), byId=new Map(), df=new Map(),sumLength=Object.fromEntries(FIELDS.map(f=>[f,0]));
  const fuzzyBuckets=new Map();
  for(let i=0;i<skills.length;i++){
    const skill=skills[i],fields={},bag=new Set();
    byId.set(fold(skill.id),i);
    for(const f of FIELDS){
      const counts=new Map();
      const input=Array.isArray(skill[f])?skill[f].join(' '):String(skill[f]??'');
      const terms=features(input);
      for(const t of terms.slice(0,130)) counts.set(t,Math.min(3,(counts.get(t)??0)+1));
      fields[f]={tf:counts,len:Math.max(1,terms.length)};sumLength[f]+=fields[f].len;
      for(const t of counts.keys())bag.add(t);
    }
    docs.push({skill,fields,bag});
    for(const term of bag){
      let posting=postings.get(term);if(!posting){posting=[];postings.set(term,posting);}
      posting.push(i);df.set(term,(df.get(term)??0)+1);
    }
  }
  for(const token of postings.keys()){
    if(token.startsWith(C)||[...token].length<4)continue;
    const prefix=[...token].slice(0,2).join('');let list=fuzzyBuckets.get(prefix);
    if(!list){list=[];fuzzyBuckets.set(prefix,list);}list.push(token);
  }
  const avg=Object.fromEntries(FIELDS.map(f=>[f,Math.max(1,sumLength[f]/Math.max(1,docs.length))]));
  const n=Math.max(1,docs.length),idf=new Map();
  for(const [token,count] of df){idf.set(token,Math.max(0.25,Math.min(4,Math.log(1+(n-count+0.5)/(count+0.5))))*(token.startsWith(C)?0.87:1));}
  // Freeze the field-normalized signal into one sparse vector per skill. Query
  // scoring becomes a small number of Map lookups; six temporary field maps die.
  for(let i=0;i<docs.length;i++){
    const doc=docs[i],strengths=new Map();
    for(const f of FIELDS){
      const {tf,len}=doc.fields[f];
      const weight=weights[f]??({id:7,name:6,keywords:5,aliases:4,tags:3,triggers:5,description:1.8})[f];
      for(const [token,freq] of tf){
        const val=weight*(freq/(freq+1.2*(0.25+0.75*len/avg[f])));
        const rec=strengths.get(token)??{score:0,name:false};
        rec.score+=val;
        if(f==='id'||f==='name')rec.name=true;
        strengths.set(token,rec);
      }
    }
    for(const [token,record] of strengths)record.score*=idf.get(token);
    docs[i]={skill:doc.skill,strengths};
  }
  return {docs,postings,byId,avg,fuzzyBuckets};
}
function termsFor(raw,words,concepts){
  const out=concepts.map(conceptToken),used=new Set(out);
  const source=fold(raw),matched=matchConcepts(source),mask=source.split('');
  // Remove the exact lexical span already represented by an interlingual concept.
  // Example: Vietnamese "đánh giá" and Chinese "安全" each count as ONE intent unit.
  for(const {start,end} of matched.values()){
    for(let i=start;i<end;i++)mask[i]=' ';
  }
  const residual=tokenize(mask.join(''));
  for(const term of residual){
    if(!used.has(term)){used.add(term);out.push(term);}
  }
  return out.slice(0,24);
}
function fuzzyAlternatives(index,term){
  if(term.startsWith(C)||[...term].length<4||index.postings.has(term))return [];
  const result=[];const a=[...term];
  const prefix=a.slice(0,2).join('');
  // Trie-like prefix bucket. Cap collisions; no entire vocabulary scanning.
  for(const candidate of (index.fuzzyBuckets.get(prefix)??[]).slice(0,300)){
    if(candidate.startsWith(term)){result.push({term:candidate,weight:0.48});}
    else if(editDistanceWithinOne(term,candidate))result.push({term:candidate,weight:0.28});
    if(result.length>=12)break;
  }
  return result;
}
function sumDocTerm(index,doc,term){
  return doc.strengths.get(term)??{score:0,name:false};
}
/** Compact retrieval with negative filters, native/vault scoping, phrase/ID boosts and honest coverage. */
export function search(index,query,options={}){
  const parsed=parseQuery(query),topK=Math.min(30,Math.max(1,Number.isInteger(options.topK)?options.topK:8));
  const listAll=(query.trim()===''||query.trim()==='*');
  if(listAll)return index.docs.filter(d=>(!options.scope||d.skill.scope===options.scope)&&(!options.allowedIds||options.allowedIds.has(d.skill.id))).slice(0,topK).map(d=>({skill:d.skill,score:0,coverage:0,matched:[]}));
  const normalizedQuery=fold(query.trim());
  const pos=termsFor(parsed.positiveRaw,parsed.positive,parsed.positiveConcepts);
  const neg=termsFor(parsed.negativeRaw,parsed.negative,parsed.negativeConcepts);
  const alternatives=new Map(),ids=new Set();
  for(const term of pos){
    const alts=[{term,weight:1},...fuzzyAlternatives(index,term)];alternatives.set(term,alts);
    for(const a of alts)for(const id of index.postings.get(a.term)??[])ids.add(id);
  }
  if(parsed.explicit){
    const id=fold(parsed.explicit);
    const target=index.byId.get(id);if(target!==undefined)ids.add(target);
  }
  const complete=[];const partial=[];
  const better=(a,b)=>a.score>b.score || (a.score===b.score && (a.coverage>b.coverage || (a.coverage===b.coverage && a.skill.id.localeCompare(b.skill.id)<0)));
  // Bounded worst-first top-k heap, not a full sort of thousands of matching skills.
  const push=(hit)=>{
    // Full-coverage-first behavior: keep two separate bounded
    // heaps. Never truncate a complete match because partials score highly.
    const heap=(options.preferFullCoverage!==false && hit.coverage===1)?complete:partial;
    if(heap.length<topK){heap.push(hit);let i=heap.length-1;
      while(i>0){const p=(i-1)>>1;if(!better(heap[p],heap[i]))break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p;}return;
    }
    if(!better(hit,heap[0]))return;
    heap[0]=hit;let i=0;
    while(true){const a=i*2+1,b=a+1;let j=i;if(a<heap.length&&better(heap[j],heap[a]))j=a;if(b<heap.length&&better(heap[j],heap[b]))j=b;if(i===j)break;[heap[i],heap[j]]=[heap[j],heap[i]];i=j;}
  };
  for(const id of ids){
    const d=index.docs[id];if(options.scope&&d.skill.scope!==options.scope)continue;
    if(options.allowedIds && !options.allowedIds.has(d.skill.id))continue;
    if(options.respectNegativeTriggers && negativeTriggerMatch(query,d.skill))continue;
    if(neg.some(term=>d.strengths.has(term)))continue;
    let value=0,hits=0,names=0;const matched=[];
    for(const term of pos){
      let best={score:0,name:false};
      for(const alt of alternatives.get(term)??[]){
        if(!d.strengths.has(alt.term))continue;
        const candidate=sumDocTerm(index,d,alt.term);
        if(candidate.score*alt.weight>best.score)best={score:candidate.score*alt.weight,name:candidate.name};
      }
      if(best.score>0){hits++;matched.push(term.startsWith(C)?term.slice(1):term);value+=best.score;if(best.name)names++;}
    }
    const exactId=parsed.explicit&&fold(parsed.explicit)===fold(d.skill.id);
    if(exactId)value+=40;
    if(!hits&&!exactId)continue;
    const coverage=hits/Math.max(1,pos.length);
    value*=Math.pow(coverage,1.3)*(1+0.08*Math.min(6,hits));
    if(parsed.phrases.length){
      const whole=fold(`${d.skill.id} ${d.skill.name} ${d.skill.description} ${(d.skill.keywords??[]).join(' ')} ${(d.skill.aliases??[]).join(' ')} ${(d.skill.triggers??[]).join(' ')} ${(d.skill.tags??[]).join(' ')}`);
      for(const phrase of parsed.phrases)if(whole.includes(phrase))value+=4;
    }
    if(normalizedQuery===d.skill.id)value+=30;
    value+=Math.min(names,3)*0.45;
    push({skill:d.skill,score:Number(value.toFixed(4)),coverage,matched});
  }
  const byScore=(a,b)=>b.score-a.score||b.coverage-a.coverage||a.skill.id.localeCompare(b.skill.id);
  complete.sort(byScore);partial.sort(byScore);
  const results=(options.preferFullCoverage!==false&&complete.length)?[...complete,...partial]:partial;
  return results.slice(0,topK);
}
