import type { MetaFunction } from "react-router";

/**
 * Public privacy policy, linked from the App Store listing and the landing
 * page. Plain HTML on purpose: it must render outside the admin, without App
 * Bridge, for a reviewer who is not logged in anywhere.
 */

export const meta: MetaFunction = () => [{ title: "Refera — Privacy policy" }];

const SUPPORT_EMAIL = "gabrielroecc@gmail.com";
const UPDATED = "September 7, 2026";

export default function Privacy() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "3rem 1.25rem",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        lineHeight: 1.6,
        color: "#1a1a1a",
      }}
    >
      <h1>Refera privacy policy</h1>
      <p>Last updated: {UPDATED}</p>

      <p>
        Refera (&ldquo;the app&rdquo;) is operated by NEXGEN (&ldquo;we&rdquo;).
        This policy explains what the app reads from your Shopify store, what it
        stores, who it shares it with, and how to have it deleted.
      </p>

      <h2>What we access</h2>
      <p>
        When you install Refera, Shopify grants it the <code>read_products</code>{" "}
        and <code>write_products</code> permissions. The app reads your
        products: titles, descriptions, product types, vendors, tags, categories,
        metafields and image alt text. It writes to those same fields only when
        you explicitly approve a suggested fix inside the app.
      </p>
      <p>
        The app also reads basic store information: your store name, domain,
        currency and primary language, so that it can ask AI assistants the kind
        of questions your buyers would ask.
      </p>
      <p>
        <strong>Refera does not access customer data.</strong> It does not read
        orders, customers, addresses, payment information or any other personal
        data about your shoppers.
      </p>

      <h2>What we store</h2>
      <p>
        We keep a copy of your product catalogue, the results of each scan
        (scores, diagnoses, simulated AI answers and suggested fixes) and your
        subscription plan, so that you can compare scans over time. Data is
        stored in a database hosted by Supabase in the United States.
      </p>

      <h2>Third parties we send data to</h2>
      <ul>
        <li>
          <strong>OpenAI</strong> (and Google Gemini as a fallback): a summary of
          your catalogue is sent to generate buyer questions and product-copy
          suggestions. Your store is never named in the simulated buyer
          questions, so the assistant answers as it would for any shopper.
        </li>
        <li>
          <strong>Vercel</strong> hosts the app, and <strong>Trigger.dev</strong>{" "}
          runs the background scans.
        </li>
      </ul>
      <p>We do not sell your data and we do not use it for advertising.</p>

      <h2>Retention and deletion</h2>
      <p>
        When you uninstall Refera, Shopify sends us a <code>shop/redact</code>{" "}
        request 48 hours later and we delete every row belonging to your store.
        You can also email us at any time to have your data deleted sooner.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data:{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
    </main>
  );
}
