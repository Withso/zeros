import { claudeRuntimeUpgradeContract } from "../../../../../../../../scripts/__tests__/claude-runtime-upgrade-contract";
import { ClaudeStreamTranslator } from "../translator";

claudeRuntimeUpgradeContract(emit => new ClaudeStreamTranslator({ sessionId: "local-runtime-upgrade", emit }));
