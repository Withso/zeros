import type {AgentGoal} from "@zeros/protocol/agent-events";
import type {CloudCommandClaim,CloudGoalSnapshot} from "@zeros/protocol/cloud-commands";

/** Native notifications and RPC acknowledgements share one confirmation order.
 * The CP confirmation outlives this execution and its foreground result. */
export class CloudGoalRecorder {
  private readonly states=new WeakMap<CloudCommandClaim,{sequence:number;flight:Promise<void>;confirmed?:CloudGoalSnapshot}>();
  constructor(private readonly persist:(claim:CloudCommandClaim,sequence:number,goal:AgentGoal|null)=>Promise<CloudGoalSnapshot>){}
  revision(claim:CloudCommandClaim):number{return this.states.get(claim)?.sequence??0;}
  observe(claim:CloudCommandClaim,goal:AgentGoal|null):Promise<void>{
    const state=this.states.get(claim)??{sequence:0,flight:Promise.resolve()};
    const sequence=++state.sequence;
    state.flight=state.flight.then(async()=>{state.confirmed=await this.persist(claim,sequence,goal);});
    this.states.set(claim,state);
    return state.flight;
  }
  async confirm(claim:CloudCommandClaim,goal:AgentGoal|null,expectedRevision:number):Promise<void>{
    // A late read/RPC response cannot overwrite a newer native notification.
    if(this.revision(claim)===expectedRevision)await this.observe(claim,goal);
    await this.flush(claim);
  }
  async flush(claim:CloudCommandClaim):Promise<CloudGoalSnapshot|undefined>{
    const state=this.states.get(claim);
    if(state){
      let flight:Promise<void>|undefined;
      while(flight!==state.flight){flight=state.flight;await flight;}
    }
    return state?.confirmed;
  }
}
