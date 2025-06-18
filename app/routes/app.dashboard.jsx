import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Frame, Card, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// ─── LOADER ─────────────────────────────────────────────
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const query = `
    query {
      shop {
        name
        email
        currencyCode
        plan {
          displayName
        }
      }
      products(first: 250) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(query);
    const result = await response.json();

    const shop = result?.data?.shop || {};
    const products = result?.data?.products?.edges || [];

    return json({
      shopName: shop.name,
      email: shop.email,
      currency: shop.currencyCode,
      plan: shop.plan?.displayName || "Unknown",
      activeProductCount: products.length,
    });
  } catch (error) {
    console.error("Error fetching store data:", error);
    return json({
      shopName: "Merchant",
      email: "Unavailable",
      currency: "-",
      plan: "Unknown",
      activeProductCount: 0,
    });
  }
}

// ─── COMPONENT ──────────────────────────────────────────
export default function DashboardPage() {
  const { shopName, email, currency, plan, activeProductCount } = useLoaderData();

  const stats = [
    { label: "Shop Name", value: shopName },
    { label: "Email", value: email },
    { label: "Plan", value: plan },
    { label: "Currency", value: currency },
    { label: "Active Products", value: activeProductCount },
  ];

  // Shared 3D card style
  const cardStyle = {
    minWidth: "220px",
    flex: "1 1 220px",
    backgroundColor: "#fefefe",
    borderRadius: "12px",
    border: "1px solid #ddd",
    boxShadow: "0 8px 15px rgba(0, 0, 0, 0.1)",
    transform: "perspective(1000px) translateZ(0)",
    transition: "transform 0.3s ease, box-shadow 0.3s ease",
  };

  const cardHoverStyle = {
    transform: "translateY(-5px) scale(1.02)",
    boxShadow: "0 12px 25px rgba(0, 0, 0, 0.15)",
  };

  return (
    <Frame>
      <Page fullWidth title="Merchant Overview">
        {/* Welcome Card with 3D Effect */}
        <div
          style={{
            padding: "3rem",
            borderRadius: "18px",
            marginBottom: "2rem",
            background: "linear-gradient(135deg, rgba(124,58,237,0.8), rgba(59,130,246,0.8))",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            color: "white",
            boxShadow: "0 15px 40px rgba(0,0,0,0.2)",
            transform: "perspective(1000px) translateZ(0)",
            transition: "transform 0.3s ease, box-shadow 0.3s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "translateY(-5px) scale(1.02)";
            e.currentTarget.style.boxShadow = "0 25px 50px rgba(0,0,0,0.25)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "translateZ(0)";
            e.currentTarget.style.boxShadow = "0 15px 40px rgba(0,0,0,0.2)";
          }}
        >
          <Text as="h1" variant="headingXl" fontWeight="bold">
            Welcome back, {shopName}!
          </Text>
          <Text as="p" variant="bodyMd" tone="inverse" style={{ marginTop: "0.5rem" }}>
            Here's an overview of your store details.
          </Text>
        </div>

        {/* Stat Cards with 3D Hover Effect */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
          {stats.map((stat, index) => (
            <div
              key={index}
              style={{ ...cardStyle }}
              onMouseEnter={(e) => {
                Object.assign(e.currentTarget.style, cardHoverStyle);
              }}
              onMouseLeave={(e) => {
                Object.assign(e.currentTarget.style, cardStyle);
              }}
            >
              <Card sectioned>
                <Text variant="headingSm" as="h2" color="subdued">
                  {stat.label}
                </Text>
                <Text variant="bodyMd" as="p" fontWeight="semibold">
                  {stat.value}
                </Text>
              </Card>
            </div>
          ))}
        </div>
      </Page>
    </Frame>
  );
}
