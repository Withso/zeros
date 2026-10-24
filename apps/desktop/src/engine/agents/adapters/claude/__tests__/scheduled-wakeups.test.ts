import { claudeWakeupContract } from "../../../../../../../../scripts/__tests__/claude-wakeup-contract";
import { ClaudeStreamTranslator } from "../translator";

claudeWakeupContract(emit => new ClaudeStreamTranslator({ sessionId: "session", emit }));
