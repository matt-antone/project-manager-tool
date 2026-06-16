type NameParts = {
  first_name?: string | null;
  last_name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
};

/** Build a human display name from a profile, falling back to email then "Teammate". */
export function getDisplayName(profile: NameParts) {
  const firstName = (profile.first_name ?? profile.firstName ?? "").trim();
  const lastName = (profile.last_name ?? profile.lastName ?? "").trim();
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || profile.email || "Teammate";
}
