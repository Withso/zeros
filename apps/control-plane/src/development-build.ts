/** The Dev source snapshot writes its immutable input digests into this module
 * before the normal Docker build. Release builds retain null. Environment
 * variables alone cannot make an unrelated image claim to be this candidate. */
export const DEVELOPMENT_BUILD: { sourceSha256: string; workerInputsSha256: string } | null = null;
