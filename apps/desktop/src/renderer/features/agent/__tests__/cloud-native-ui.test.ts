import {describe,expect,it} from "vitest";
import {composerCommandsFor} from "@zeros/protocol/agent-events";
import {cloudWorkspaceKey} from "../../../platform/bridge/cloud-workspace-key";
import {filterCloudNativeCommands} from "../cloud-native-ui";
const cwd=cloudWorkspaceKey({organizationId:"11111111-1111-4111-8111-111111111111",workspaceId:"22222222-2222-4222-8222-222222222222"});
describe("cloud native commands",()=>{
  it("hides goals and native review in cloud while preserving Local commands",()=>{
    const commands=composerCommandsFor("codex");
    expect(filterCloudNativeCommands(commands,"/local")).toBe(commands);
    expect(filterCloudNativeCommands(commands,cwd).map(row=>row.name)).not.toEqual(expect.arrayContaining(["goal","review"]));
  });
});
