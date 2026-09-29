import { chmod, mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { CloudSkillSchema } from "@zeros/protocol/cloud-customization";

/** Called only while creating a fresh engine-owned private HOME, before any
 * provider can run. The sibling source is mounted read-only over skill paths. */
export async function materializeCloudSkills(directory: string, input: z.infer<typeof CloudSkillSchema>[]) {
  const skills = z.array(CloudSkillSchema).max(64).parse(input);
  await mkdir(`${directory}/skills`, { mode: 0o755 });
  await chmod(`${directory}/skills`, 0o755);
  for (const skill of skills) {
    await mkdir(`${directory}/skills/${skill.name}`, { mode: 0o755 });
    await chmod(`${directory}/skills/${skill.name}`, 0o755);
    await writeFile(`${directory}/skills/${skill.name}/SKILL.md`, `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description || `Organization skill ${skill.name}`)}\n---\n\n${skill.content}`, { flag: "wx", mode: 0o444 });
    await chmod(`${directory}/skills/${skill.name}/SKILL.md`, 0o444);
  }
}
