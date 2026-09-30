import {describe,expect,it} from "vitest";
import {PermissionModeChanges} from "../permission-mode-change";

describe("permission mode request ownership",()=>{
  it("does not let an older failed request undo a newer choice, including A → B → A",()=>{
    const requests=new PermissionModeChanges();
    const first=requests.begin("chat","execution");
    const second=requests.begin("chat","execution");
    second.finish();
    const third=requests.begin("chat","execution");
    expect(first.owns("execution")).toBe(false);
    first.finish();
    expect(third.owns("execution")).toBe(true);
    expect(third.owns("replacement")).toBe(false);
    third.finish();expect(third.owns("execution")).toBe(false);
  });
  it("keeps overlapping choices isolated between chats and releases settled requests",()=>{
    const requests=new PermissionModeChanges(),a=requests.begin("a","execution-a"),b=requests.begin("b","execution-b");
    a.finish();expect(b.owns("execution-b")).toBe(true);b.finish();
    expect(b.owns("execution-b")).toBe(false);
  });
});
