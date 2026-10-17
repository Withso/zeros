// The path rule shared by style source declarations and the private settings
// that approve their builds. Dependency-free so settings can import it.

/** A repository-relative POSIX path to a .css file, or the reason it is not one. */
export function designStyleSourcePathError(value: string): string | null {
  if (!value || value.length > 1024) return "Path must be 1-1024 characters.";
  if (/[\\\0]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return "Path must be repository-relative and use forward slashes.";
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "Path must not contain empty, '.' or '..' segments.";
  }
  if (segments[0] === ".git" || segments[0] === ".zeros") {
    return "Path must not point into .git or .zeros.";
  }
  if (!value.toLowerCase().endsWith(".css")) return "Only .css files can be imported.";
  return null;
}

/** A Sass source's entry: the same rule with a .scss or .sass file. */
export function designSassSourcePathError(value: string): string | null {
  const lower = value.toLowerCase();
  if (!lower.endsWith(".scss") && !lower.endsWith(".sass")) {
    return value ? "A Sass source names a .scss or .sass file." : "Path must be 1-1024 characters.";
  }
  const error = designStyleSourcePathError(`${value.slice(0, -5)}.css`);
  return error === "Only .css files can be imported." ? null : error;
}

/** Private, locally excluded folder for build-source outputs, so a build
 * writes nothing Git would show. */
export const DESIGN_STYLE_BUILD_DIRECTORY = ".zeros/design-styles";

/** A build source's output: a source path, or a .css file in the private
 * build folder. */
export function designBuildOutputPathError(value: string): string | null {
  const prefix = `${DESIGN_STYLE_BUILD_DIRECTORY}/`;
  if (!value.startsWith(prefix)) return designStyleSourcePathError(value);
  const error = designStyleSourcePathError(value.slice(prefix.length));
  return error ? `${error.replace(/\.$/, "")} (inside ${prefix}).` : null;
}

/** A repository-relative file or folder whose changes re-run a one-shot build. */
export function designBuildInputPathError(value: string): string | null {
  if (!value || value.length > 512) return "Paths must be 1-512 characters.";
  if (/[\\\0*?[\]{}]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return "Paths must be repository-relative files or folders, without glob characters.";
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "Paths must not contain empty, '.' or '..' segments.";
  }
  if (segments[0] === ".git" || segments[0] === ".zeros") return "Paths must not point into .git or .zeros.";
  return null;
}
