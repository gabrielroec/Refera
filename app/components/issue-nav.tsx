import type { IssueSibling } from "../services/dashboard.server";

/**
 * Section navigation for everything under /app/issues.
 *
 * Deliberately not a tab group: each entry is a link to its own route, so the
 * back button, deep links and bookmarks all keep working. Real tabs would also
 * be the wrong pattern — Polaris ships no tab component, and Built for Shopify
 * rejects tab groups whose content shifts what sits above them.
 */
export function IssueNav({
  siblings,
  current,
}: {
  siblings: IssueSibling[];
  /** The issue slug being viewed, or "index" on the issues list itself. */
  current: string;
}) {
  if (siblings.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--s-space-small-300, 6px)",
      }}
    >
      <s-button
        href="/app/issues"
        variant={current === "index" ? "secondary" : "tertiary"}
        {...(current === "index" ? { disabled: true } : {})}
      >
        All issues
      </s-button>

      {siblings.map((sibling) => (
        <s-button
          key={sibling.slug}
          href={`/app/issues/${sibling.slug}`}
          variant={sibling.slug === current ? "secondary" : "tertiary"}
          {...(sibling.slug === current ? { disabled: true } : {})}
        >
          {sibling.label}
          {sibling.pending > 0 ? ` (${sibling.pending})` : " ✓"}
        </s-button>
      ))}
    </div>
  );
}
