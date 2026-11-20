export class SessionLedger {
  constructor({sessionTtlMs,maxSessions}){this.ttl=sessionTtlMs;this.max=maxSessions;this.states=new Map();}
  state(id, create=true){
    if(typeof id!=='string' || !id) return null;
    const now=Date.now();
    for(const [key,v] of this.states)if(now-v.last>this.ttl)this.states.delete(key);
    let s=this.states.get(id);
    if(!s && create){if(this.states.size>=this.max)this.states.delete(this.states.keys().next().value);s={last:now,hints:new Set(),loads:new Map(),receipt:null,semanticTasks:new Map()};this.states.set(id,s);}
    if(s){s.last=now;this.states.delete(id);this.states.set(id,s);}
    return s;
  }
  hinted(id,skill){return !!this.state(id,false)?.hints.has(skill);}
  markHint(id,skill){const state=this.state(id);if(!state)return; if(state.hints.size>=128)state.hints.delete(state.hints.values().next().value);state.hints.add(skill);}
  loaded(id,skill){return this.state(id,false)?.loads.get(skill);}
  markLoad(id,skill,path){const state=this.state(id);if(!state)return;if(state.loads.size>=128)state.loads.delete(state.loads.keys().next().value);state.loads.set(skill,path);}
  record(id,receipt){const state=this.state(id);if(!state)return;state.receipt={ids:[...receipt.ids].slice(0,128),source:receipt.source,mode:receipt.mode,at:Date.now()};}
  receipt(id){return this.state(id,false)?.receipt??null;}
  getTaskSelection(id,task){return this.state(id,false)?.semanticTasks.get(task);}
  setTaskSelection(id,task,selection){const state=this.state(id);if(!state)return;if(state.semanticTasks.size>=64)state.semanticTasks.delete(state.semanticTasks.keys().next().value);state.semanticTasks.set(task,[...selection]);}
  delete(id){if(typeof id==='string'&&id)this.states.delete(id);}
  clear(){this.states.clear();}
}
