import { Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import Sidebar from "../components/Sidebar";
import { useState } from "react"; // ← Added this

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const [showSidebar, setShowSidebar] = useState(true); // ← Added this

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <div style={{ display: "flex", height: "100vh" }}>
        {/* Sidebar on the left */}
        {showSidebar && (
          <div
            style={{
              width: "240px",
              background: "#0f0f1b",
              color: "white",
              padding: "1rem",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Sidebar />
          </div>
        )}

        {/* Main content area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              height: "50px",
              background: "#f2f2f2",
              display: "flex",
              alignItems: "center",
              padding: "0 1rem",
              borderBottom: "1px solid #ddd",
            }}
          >
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              style={{
                fontSize: "1.2rem",
                cursor: "pointer",
                marginRight: "1rem",
              }}
            >
              ←
            </button>

            <h2 style={{ margin: 0 }}>Content Manager</h2>
          </div>
          <main style={{ flex: 1, padding: "1rem", background: "#f9f9f9" }}>
            <Outlet />
          </main>
        </div>
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
