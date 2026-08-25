import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {/*
          rel="home" designates the landing route AND hides this link: the app
          name in the sidebar already navigates here, and a visible duplicate
          home entry is a documented Built for Shopify rejection reason.
          The Polaris typings omit `rel`, but App Bridge's SAppNavLinkAttributes
          defines it — hence the spread.
        */}
        <s-link href="/app" {...{ rel: "home" }}>
          Overview
        </s-link>
        {/*
          Fixed sections only. Listing each issue type here was tried and
          reverted: those entries change between scans, so the sidebar would
          rearrange itself under the merchant, and it cost a query on every
          navigation. Drilling into an issue is the job of the Issues screen.
        */}
        <s-link href="/app/issues">Issues</s-link>
        <s-link href="/app/answers">AI answers</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
