export function ClientStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="clientStatusBadge tone-unknown">—</span>;
  const label = status.replace(/_/g, " ");
  return (
    <span className={`clientStatusBadge tone-${status}`} aria-label={label}>
      {label}
    </span>
  );
}
