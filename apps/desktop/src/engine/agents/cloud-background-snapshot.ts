import type {BackgroundTask} from "@zeros/protocol/agent-events";

// CP accepts 192 KiB including JSON escaping. Reserve the envelope/activity
// overhead, then bound each of 64 rows independently so every native ID fits.
const ROW_BYTES=Math.floor((192*1024-1024)/64)-1;
function jsonPrefix(value:string,bytes:number):string{
  let low=0,high=value.length;
  while(low<high){
    const end=Math.ceil((low+high)/2);
    if(Buffer.byteLength(JSON.stringify(value.slice(0,end)))<=bytes)low=end;else high=end-1;
  }
  // Keep Unicode pairs intact when a display field ends at the byte limit.
  if(low<value.length&&low>0&&/[\uD800-\uDBFF]/.test(value[low-1]!)&&/[\uDC00-\uDFFF]/.test(value[low]!))low--;
  return value.slice(0,low);
}
export function projectCloudBackgroundTasks(tasks:readonly BackgroundTask[]):BackgroundTask[]{
  return tasks.slice(0,64).flatMap(source=>{
    // Opaque stop identities are never truncated or synthesized. A record
    // outside the wire contract stays native work, even if it is not visible.
    if(!source.taskId||source.taskId.length>256)return [];
    const task:BackgroundTask={taskId:source.taskId,name:"Background task",startedAt:source.startedAt,updatedAt:source.updatedAt,
      ...(source.scheduledFor!==undefined?{scheduledFor:source.scheduledFor}:{})};
    for(const [key,limit] of [["name",512],["taskType",128],["command",1024],["summary",1024],["lastToolName",128]] as const){
      const value=source[key];if(!value)continue;
      const available=ROW_BYTES-Buffer.byteLength(JSON.stringify({...task,[key]:""}))+2;
      const display=jsonPrefix(value.slice(0,limit),Math.max(0,available));
      if(display)task[key]=display;
    }
    return [task];
  });
}
