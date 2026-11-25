export function parseBuildEdition(value: string | undefined) {
  const edition = value?.trim() || "standard";
  if (edition === "standard" || edition === "corporate") return edition;
  throw new Error('T3CODE_BUILD_EDITION must be "standard" or "corporate".');
}
