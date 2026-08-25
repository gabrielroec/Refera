import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useOutletContext, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/billing.server";
import { loadIssueNav, type IssueSibling } from "../services/dashboard.server";

/**
 * Layout for everything under /app/issues.
 *
 * Its only job is to load the section navigation once and hand it down, so
 * moving between the issue list and any review queue costs no extra query and
 * the navigation never flickers or reorders.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return { siblings: await loadIssueNav(shop.id) };
};

export interface IssuesContext {
  siblings: IssueSibling[];
}

/** Typed access to the section navigation from any child route. */
export function useIssuesContext(): IssuesContext {
  return useOutletContext<IssuesContext>();
}

export default function IssuesLayout() {
  const { siblings } = useLoaderData<typeof loader>();
  return <Outlet context={{ siblings } satisfies IssuesContext} />;
}

export function ErrorBoundary() {
  // Pass the real error through: replacing it with a label hides the actual
  // cause (a Prisma validation error once surfaced here as a bare string).
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
