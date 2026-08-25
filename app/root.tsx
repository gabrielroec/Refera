import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";

/**
 * The document shell.
 *
 * Split out from the route component so the error boundary below renders
 * *inside* it. Without this, an error thrown outside a route's own boundary
 * replaces the whole document — including `Scripts`, which is what loads App
 * Bridge — and the merchant sees a blank frame in the admin with the reason
 * only in the browser console.
 */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Last-resort error screen.
 *
 * The Shopify boundary helper re-throws anything that is not an ErrorResponse,
 * so a plain exception from a loader — a Prisma error, a failed API call —
 * arrives here. It has to say something a merchant can act on, in the admin's
 * own visual language, rather than showing React Router's default stack page
 * inside an iframe.
 *
 * The underlying message is shown only outside production: it is useful while
 * developing and is exactly the kind of thing that leaks a connection string to
 * a merchant.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  // eslint-disable-next-line no-undef
  const showDetail = process.env.NODE_ENV !== "production";

  const heading = isRouteErrorResponse(error)
    ? error.status === 404
      ? "That page doesn't exist"
      : "Something went wrong"
    : "Something went wrong";

  const detail = isRouteErrorResponse(error)
    ? error.statusText || String(error.data ?? "")
    : error instanceof Error
      ? error.message
      : String(error);

  return (
    <div
      style={{
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        padding: "48px 24px",
        maxWidth: 520,
        margin: "0 auto",
        color: "#303030",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 650, margin: "0 0 8px" }}>{heading}</h1>
      <p style={{ margin: "0 0 20px", opacity: 0.7, fontSize: 14 }}>
        Nothing in your store was changed. Reloading usually clears it — if it
        keeps happening, the scan history and your settings are all still there.
      </p>

      {showDetail && detail && (
        <pre
          style={{
            background: "#f1f1f1",
            border: "1px solid #e3e3e3",
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            overflowX: "auto",
            margin: "0 0 20px",
          }}
        >
          {detail}
        </pre>
      )}

      <a
        href="/app"
        style={{
          display: "inline-block",
          background: "#303030",
          color: "#fff",
          padding: "8px 16px",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Back to Refera
      </a>
    </div>
  );
}
