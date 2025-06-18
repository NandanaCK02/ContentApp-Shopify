import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  TextField,
  Tabs,
  Card,
  Thumbnail,
  Text,
} from "@shopify/polaris";
import { useCallback } from "react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const queryParam = url.searchParams.get("query") || "";
  const typeParam = url.searchParams.get("type") || "ALL";

  const { admin } = await authenticate.admin(request);

  const gql = `
    query FetchFiles {
      files(first: 50) {
        edges {
          node {
            id
            alt
            createdAt
            fileStatus
            preview {
              image {
                url
              }
            }
            ... on MediaImage {
              image {
                url
              }
            }
            ... on Video {
              sources {
                url
              }
            }
            ... on GenericFile {
              originalFileSize
              mimeType
            }
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(gql);
    const data = await response.json();

    let files = data?.data?.files?.edges?.map((edge) => edge.node) || [];

    // Filter by type (in JS, since GraphQL doesn't support it)
    files = files.filter((file) => {
      if (typeParam === "ALL") return true;
      if (typeParam === "IMAGE") return file.image?.url;
      if (typeParam === "VIDEO") return file.sources?.[0]?.url;
      if (typeParam === "DOCUMENT") return file.mimeType || file.originalFileSize;
      return true;
    });

    // Filter by query if present
    if (queryParam) {
      const q = queryParam.toLowerCase();
      files = files.filter((file) =>
        (file.alt || "").toLowerCase().includes(q)
      );
    }

    return json({ files, query: queryParam, type: typeParam });
  } catch (error) {
    console.error("Error fetching media:", error);
    return json({ files: [], query: queryParam, type: typeParam });
  }
};

export default function MediaPage() {
  const { files, query, type } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs = [
    { id: "ALL", content: "All Files" },
    { id: "IMAGE", content: "Images" },
    { id: "VIDEO", content: "Videos" },
    { id: "DOCUMENT", content: "Documents" },
  ];

  const handleTabChange = useCallback(
    (selectedTabId) => {
      const newParams = new URLSearchParams(searchParams);
      newParams.set("type", selectedTabId);
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams]
  );

  const handleSearchChange = (val) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("query", val);
    newParams.set("type", type);
    setSearchParams(newParams);
  };

  return (
    <Page title="Media Library">
      <Layout>
        <Layout.Section>
          <Form method="get">
            <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
              <TextField
                labelHidden
                label="Search"
                name="query"
                value={query}
                onChange={handleSearchChange}
                placeholder="Search files by name..."
              />
            </div>
          </Form>

          <Tabs
            tabs={tabs}
            selected={tabs.findIndex((t) => t.id === type)}
            onSelect={(index) => handleTabChange(tabs[index].id)}
          />

          <div
            style={{
              marginTop: "1.5rem",
              display: "grid",
              gap: "1.5rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            }}
          >
            {files.length === 0 ? (
              <Text>No files found.</Text>
            ) : (
              files.map((node) => {
                const previewUrl = node.preview?.image?.url;

                if (node.image?.url) {
                  return (
                    <Card key={node.id} sectioned>
                      <Thumbnail source={node.image.url} alt={node.alt || "Image"} size="large" />
                      <Text variant="bodyMd" fontWeight="medium">
                        {node.alt || "Untitled Image"}
                      </Text>
                    </Card>
                  );
                }

                if (node.sources?.[0]?.url) {
                  return (
                    <Card key={node.id} sectioned>
                      <Text variant="bodyMd" fontWeight="medium">🎬 Video</Text>
                      <Text size="small">{node.sources[0].url}</Text>
                    </Card>
                  );
                }

                if (node.mimeType || node.originalFileSize) {
                  return (
                    <Card key={node.id} sectioned>
                      <Text variant="bodyMd" fontWeight="medium">📄 Document</Text>
                      <Text size="small">Type: {node.mimeType}</Text>
                      <Text size="small">Size: {Math.round((node.originalFileSize || 0) / 1024)} KB</Text>
                    </Card>
                  );
                }

                if (previewUrl) {
                  return (
                    <Card key={node.id} sectioned>
                      <Thumbnail source={previewUrl} alt="Preview" size="large" />
                      <Text variant="bodyMd">{node.alt || "Untitled File"}</Text>
                    </Card>
                  );
                }

                return null;
              })
            )}
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
