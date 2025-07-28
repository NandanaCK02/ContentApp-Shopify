// app/routes/collections.jsx

import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useFetcher,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  LegacyStack,
  Text,
  DropZone,
  DataTable,
  Frame,
  Toast,
  Link,
  List,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";

// --- GraphQL Queries and Mutations ---

const GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY = `
  query getCollections($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        descriptionHtml
        sortOrder
        templateSuffix
        updatedAt
        image { src }
        metafields(first: 250) {
          nodes {
            namespace
            key
            value
            type # <-- Crucial: We need the metafield's defined type for export and import logic
          }
        }
      }
    }
  }
`;

const UPDATE_COLLECTION_MUTATION = `
  mutation collectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id }
      userErrors { field message }
    }
  }
`;

const CREATE_METAFIELD_MUTATION = `
  mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const GET_COLLECTION_TITLES_QUERY = `
  query getCollectionTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Collection {
        id
        title
      }
    }
  }
`;

// --- Loader ---

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  if (!session || !admin) {
    throw new Response("Unauthorized", { status: 401 });
  }

  let collections = [];
  let cursor = null;
  let hasNextPage = true;

  try {
    while (hasNextPage) {
      const response = await admin.graphql(GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY, {
        variables: { cursor },
      });
      const data = await response.json();

      if (data.errors) {
        console.error("GraphQL loader errors (GET_ALL_COLLECTIONS_WITH_METAFIELDS):", JSON.stringify(data.errors, null, 2));
        throw new Error(`Failed to fetch collections: ${JSON.stringify(data.errors.map(e => e.message).join(", "))}`);
      }

      const result = data.data.collections;

      collections.push(...result.nodes);
      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor;
    }

    // Convert GIDs in metafield values to names for display in the UI
    // IMPORTANT: This conversion is for display ONLY. The `metafield.type` is crucial for export.
    for (const collection of collections) {
      for (const metafield of collection.metafields.nodes) {
        if (metafield.type === 'list.collection_reference' && typeof metafield.value === 'string') {
            let gids = [];
            try {
                const parsed = JSON.parse(metafield.value); // Value from Shopify for list.collection_reference is a JSON array string
                if (Array.isArray(parsed)) {
                    gids = parsed;
                }
            } catch {
                // Not a valid JSON array string, might be malformed or empty
                gids = [];
            }

            const validGids = [...new Set(gids.filter(gid => typeof gid === 'string' && gid.startsWith("gid://shopify/Collection/")))];

            if (validGids.length > 0) {
                try {
                    const response = await admin.graphql(GET_COLLECTION_TITLES_QUERY, {
                        variables: { ids: validGids },
                    });
                    const result = await response.json();

                    if (result.errors) {
                        console.error("GraphQL loader (GET_COLLECTION_TITLES) errors for metafield GIDs:", JSON.stringify(result.errors, null, 2));
                        continue;
                    }

                    const titleMap = {};
                    for (const node of result.data.nodes) {
                        if (node && node.id && node.title) titleMap[node.id] = node.title;
                    }
                    metafield.displayValue = validGids.map((gid) => titleMap[gid] || `[Invalid GID: ${gid}]`).join(", ");
                } catch (error) {
                    console.error(`Error resolving GIDs for collection ${collection.id}, metafield ${metafield.key}:`, error);
                    metafield.displayValue = "Error resolving references.";
                }
            } else {
                metafield.displayValue = ""; // No valid GIDs to display
            }
        } else if (metafield.type === 'collection_reference' && typeof metafield.value === 'string' && metafield.value.startsWith("gid://shopify/Collection/")) {
            // For single collection_reference
            try {
                const response = await admin.graphql(GET_COLLECTION_TITLES_QUERY, {
                    variables: { ids: [metafield.value] },
                });
                const result = await response.json();
                if (!result.errors && result.data?.nodes?.[0]?.title) {
                    metafield.displayValue = result.data.nodes[0].title;
                } else {
                    metafield.displayValue = `[Invalid GID: ${metafield.value}]`;
                }
            } catch (error) {
                console.error(`Error resolving single GID for collection ${collection.id}, metafield ${metafield.key}:`, error);
                metafield.displayValue = "Error resolving reference.";
            }
        } else {
            // For all other metafield types, display the raw value
            metafield.displayValue = metafield.value;
        }
      }
    }
  } catch (error) {
    console.error("Error in collections loader:", error);
    return json({ collections: [], error: error.message || "Failed to load collections." }, { status: 500 });
  }

  return json({ collections });
};

// --- Action (Import) ---

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  if (!session) {
    return json({ success: false, error: "Authentication required.", status: 401 }, { status: 401 });
  }

  const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 50_000_000 }); // 50 MB
  let formData;
  try {
    formData = await unstable_parseMultipartFormData(request, uploadHandler);
  } catch (error) {
    console.error("Error parsing multipart form data:", error);
    return json({ success: false, error: "Failed to parse file upload. File might be too large or corrupted.", details: error.message }, { status: 400 });
  }

  const file = formData.get("file");

  if (!file || !(file instanceof Blob)) {
    return json({ success: false, error: "No file uploaded or invalid file type. Please upload an Excel (.xlsx) file.", status: 400 }, { status: 400 });
  }

  let workbook;
  let worksheet;
  let headerRow;
  let metafieldKeys = [];
  // Store original metafield types from loader for use in action
  let originalMetafieldTypesMap = {};

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    worksheet = workbook.worksheets[0];

    if (!worksheet) {
      return json({ success: false, error: "Excel file is empty or invalid format. No worksheet found.", status: 400 });
    }

    headerRow = worksheet.getRow(1);
    if (!headerRow || headerRow.values.length < 6) { // Collection ID, Title, Description Html, Sort Order, Template Suffix
      return json({ success: false, error: "Excel file is missing expected header columns (Collection ID, Title, Description Html, Sort Order, Template Suffix).", status: 400 });
    }

    // Extract metafield keys from headers
    metafieldKeys = headerRow.values
      .slice(6) // Metafields start from Column F (index 6)
      .filter(h => typeof h === "string" && h.trim() !== "")
      .map(h => h.trim());

    if (metafieldKeys.length > 0) {
        console.log("Identified Metafield Keys for import:", metafieldKeys);
    }

    // --- NEW: Fetch collection data again to get metafield *definitions* (types) ---
    // This is crucial for matching types on import.
    // This is a tradeoff: another API call, but ensures correct type handling.
    // An alternative: pass original types from loader to client and then to action via hidden field.
    // For simplicity and directness, fetching here:
    const { session: currentSession, admin: currentAdmin } = await authenticate.admin(request);
    if (!currentSession || !currentAdmin) {
        // Should not happen if previous auth check passed, but for safety
        return json({ success: false, error: "Authentication required for type lookup.", status: 401 }, { status: 401 });
    }

    let allCollectionsForTypes = [];
    let typeCursor = null;
    let typeHasNextPage = true;
    while(typeHasNextPage) {
        const typeResponse = await currentAdmin.graphql(GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY, {
            variables: { cursor: typeCursor },
        });
        const typeData = await typeResponse.json();
        if (typeData.errors) {
            console.error("GraphQL loader errors (GET_ALL_COLLECTIONS_WITH_METAFIELDS for types):", JSON.stringify(typeData.errors, null, 2));
            // Don't fail import entirely, but log and proceed with best guess types
            break;
        }
        const typeResult = typeData.data.collections;
        allCollectionsForTypes.push(...typeResult.nodes);
        typeHasNextPage = typeResult.pageInfo.hasNextPage;
        typeCursor = typeResult.pageInfo.endCursor;
    }

    // Build a map of metafield key to its defined type from Shopify
    allCollectionsForTypes.forEach(collection => {
        collection.metafields.nodes.forEach(mf => {
            // Take the first encountered type for a key. Assumes consistency across collections.
            if (!originalMetafieldTypesMap[mf.key]) {
                originalMetafieldTypesMap[mf.key] = mf.type;
            }
        });
    });
    console.log("Original Metafield Types Map:", originalMetafieldTypesMap);


  } catch (error) {
    console.error("Error reading Excel file or fetching metafield types:", error);
    return json({ success: false, error: `Failed to read Excel file or retrieve metafield types: ${error.message}. Ensure it's a valid .xlsx format.`, status: 400 }, { status: 400 });
  }

  let errors = [];
  let processedRowsCount = 0;
  let updatedCollectionsCount = 0;
  let updatedMetafieldsCount = 0;

  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    const id = row.getCell(1)?.value?.toString()?.trim(); // Collection ID is Column A (index 1)
    const title = row.getCell(2)?.value?.toString() || ""; // Title is Column B (index 2)
    const descriptionHtml = row.getCell(3)?.value?.toString() || ""; // Description is Column C (index 3)
    const sortOrderRaw = row.getCell(4)?.value; // Sort Order is Column D (index 4)
    const templateSuffix = row.getCell(5)?.value?.toString() || null; // Template Suffix is Column E (index 5)

    // Validate Collection ID
    if (!id || !id.startsWith("gid://shopify/Collection/")) {
      errors.push({
        row: rowIndex,
        message: `Missing or invalid Collection ID in Column A. Expected format: 'gid://shopify/Collection/12345'. Found: "${id || 'EMPTY'}"`
      });
      continue;
    }

    const input = {
      id: id, // Pass the GID within the input object
      title,
      descriptionHtml,
    };

    if (sortOrderRaw) {
      const sortOrder = sortOrderRaw.toString().toUpperCase().trim();
      const validSortOrders = ['ALPHA_ASC', 'ALPHA_DESC', 'BEST_SELLING', 'CREATED', 'MANUAL', 'PRICE_ASC', 'PRICE_DESC'];
      if (validSortOrders.includes(sortOrder)) {
        input.sortOrder = sortOrder;
      } else {
          errors.push({ row: rowIndex, message: `Invalid Sort Order value in Column D: "${sortOrderRaw}". Must be one of: ${validSortOrders.join(", ")}. Skipping sortOrder update.` });
      }
    }

    if (templateSuffix) {
      input.templateSuffix = templateSuffix;
    }

    // --- Update Collection Core Fields ---
    let collectionUpdateSuccess = false;
    try {
      const updateResponse = await admin.graphql(UPDATE_COLLECTION_MUTATION, {
        variables: { input },
      });
      const updateResult = await updateResponse.json();

      if (updateResult.errors) {
        errors.push({
          row: rowIndex,
          message: `Collection update GraphQL errors: ${JSON.stringify(updateResult.errors.map(e => e.message).join(", "))}`,
        });
      } else if (updateResult.data?.collectionUpdate?.userErrors?.length) {
        errors.push({
          row: rowIndex,
          message: `Collection update user errors: ${JSON.stringify(updateResult.data.collectionUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join("; "))}`,
        });
      } else {
        updatedCollectionsCount++;
        collectionUpdateSuccess = true;
      }
    } catch (e) {
      console.error(`Error updating collection ${id} (row ${rowIndex}):`, e);
      errors.push({ row: rowIndex, message: `Collection update failed for ID ${id}: ${e.message}` });
    }

    // --- Update Metafields ---
    const metafieldInputs = [];
    for (let i = 0; i < metafieldKeys.length; i++) {
      const colIndexForMetafield = i + 6; // Metafields start from Column F (index 6)
      const key = metafieldKeys[i];
      const rawValue = row.getCell(colIndexForMetafield)?.value;

      // Determine the Shopify defined type for this metafield key
      const shopifyDefinedType = originalMetafieldTypesMap[key] || "single_line_text_field"; // Default if not found

      if (rawValue !== null && rawValue !== undefined && rawValue.toString().trim() !== "") {
        let valueToSet = rawValue.toString().trim();
        let metafieldType = shopifyDefinedType; // Start with the known definition type

        // --- METAFIELD TYPE & VALUE VALIDATION LOGIC ---

        if (shopifyDefinedType === 'list.collection_reference') {
            // For list.collection_reference, value *must* be a JSON string of GIDs.
            // Try to parse it, if it's not a valid array, handle it.
            try {
                const parsedValue = JSON.parse(valueToSet);
                if (!Array.isArray(parsedValue) || parsedValue.some(item => typeof item !== 'string' || !item.startsWith("gid://shopify/Collection/"))) {
                    // It's JSON but not an array of GIDs, or contains invalid GIDs
                    errors.push({
                        row: rowIndex,
                        message: `Metafield '${key}' in Column ${String.fromCharCode(65 + colIndexForMetafield -1)}: Expected a JSON array of valid GIDs for 'list.collection_reference'. Found "${valueToSet}". Setting an empty list.`
                    });
                    valueToSet = JSON.stringify([]);
                }
                // Else, valueToSet is already a valid JSON array of GIDs, keep as is
            } catch (e) {
                // Not a valid JSON string at all
                if (valueToSet.startsWith("gid://shopify/Collection/")) {
                    // If it's a single GID, wrap it in a JSON array string
                    valueToSet = JSON.stringify([valueToSet]);
                } else if (valueToSet.startsWith("gid://shc")) {
                     // Incomplete GID - treat as invalid. You might want to remove this or log it more harshly.
                     errors.push({ row: rowIndex, message: `Metafield '${key}' in Column ${String.fromCharCode(65 + colIndexForMetafield -1)}: Incomplete GID "${valueToSet}". Expected full GID for 'list.collection_reference'. Setting an empty list.` });
                     valueToSet = JSON.stringify([]);
                } else {
                    errors.push({
                        row: rowIndex,
                        message: `Metafield '${key}' in Column ${String.fromCharCode(65 + colIndexForMetafield -1)}: Invalid format for 'list.collection_reference'. Expected JSON array string of GIDs. Found "${valueToSet}". Setting an empty list.`
                    });
                    valueToSet = JSON.stringify([]);
                }
            }
        } else if (shopifyDefinedType === 'collection_reference') {
            // For single collection_reference, value *must* be a single GID string.
            if (!valueToSet.startsWith("gid://shopify/Collection/")) {
                errors.push({
                    row: rowIndex,
                    message: `Metafield '${key}' in Column ${String.fromCharCode(65 + colIndexForMetafield -1)}: Expected a single valid GID for 'collection_reference'. Found "${valueToSet}". Setting null.`
                });
                valueToSet = null; // Set to null for single reference if invalid
            }
            // Else, valueToSet is a valid single GID, keep as is
        } else if (shopifyDefinedType === 'number_integer' || shopifyDefinedType === 'number_decimal') {
            if (isNaN(parseFloat(valueToSet))) {
                errors.push({
                    row: rowIndex,
                    message: `Metafield '${key}' in Column ${String.fromCharCode(65 + colIndexForMetafield -1)}: Expected a number. Found "${valueToSet}". Setting null.`
                });
                valueToSet = null;
            } else {
                valueToSet = parseFloat(valueToSet).toString(); // Ensure it's a string representation of the number
            }
        } else if (shopifyDefinedType === 'json') {
            if (!isValidJson(valueToSet)) {
                errors.push({
                    row: rowIndex,
                    message: `Metafield '${key}' in Column ${String.fromCharCode(65 + colIndexForMetafield -1)}: Expected valid JSON. Found "${valueToSet}". Setting null.`
                });
                valueToSet = null;
            }
        }
        // Add more specific handling for other known types (boolean, url, date, etc.)
        // For 'file_reference' or 'image_reference', `valueToSet` should be the GID of the file/image.

        if (valueToSet !== null) { // Only add if value is not explicitly null
            metafieldInputs.push({
              ownerId: id,
              namespace: "custom", // Default namespace
              key,
              type: metafieldType, // Use the determined type
              value: valueToSet,
            });
        }
      } else {
          // If the cell is empty, and it's a reference type, consider setting to null to clear it
          if (shopifyDefinedType === 'collection_reference' || shopifyDefinedType === 'list.collection_reference' /* add other reference types */) {
               metafieldInputs.push({
                  ownerId: id,
                  namespace: "custom",
                  key,
                  type: shopifyDefinedType, // Must provide correct type even for nulling
                  value: null, // Set to null to clear the reference
               });
          }
      }
    }

    if (metafieldInputs.length > 0) {
      try {
        const metafieldResponse = await admin.graphql(CREATE_METAFIELD_MUTATION, {
          variables: { metafields: metafieldInputs },
        });
        const metafieldResult = await metafieldResponse.json();

        if (metafieldResult.errors) {
            errors.push({
                row: rowIndex,
                message: `Metafield GraphQL errors: ${JSON.stringify(metafieldResult.errors.map(e => e.message).join(", "))}`
            });
        } else if (metafieldResult.data?.metafieldsSet?.userErrors?.length) {
          errors.push({
            row: rowIndex,
            message: `Metafield update user errors: ${JSON.stringify(metafieldResult.data.metafieldsSet.userErrors.map(e => `${e.field}: ${e.message}`).join("; "))}`,
          });
        } else if (metafieldResult.data?.metafieldsSet?.metafields?.length) {
            updatedMetafieldsCount += metafieldResult.data.metafieldsSet.metafields.length;
        }

      } catch (e) {
        console.error(`Error updating metafields for collection ${id} (row ${rowIndex}):`, e);
        errors.push({ row: rowIndex, message: `Metafield update failed for ID ${id}: ${e.message}` });
      }
    }
    processedRowsCount++;
  }

  let summaryMessage = `Import process completed.`;
  if (errors.length > 0) {
    summaryMessage += ` ${updatedCollectionsCount} collections updated successfully, ${updatedMetafieldsCount} metafields set. Found ${errors.length} row-level errors.`;
  } else {
    summaryMessage += ` All ${processedRowsCount} collections and their metafields updated successfully.`;
  }

  return json({
    success: errors.length === 0,
    message: summaryMessage,
    errors,
    processedRowsCount,
    updatedCollectionsCount,
    updatedMetafieldsCount,
    importedFileName: file.name,
  }, { status: errors.length > 0 ? 400 : 200 });
};

// Helper functions
function isValidJson(str) {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch (e) {
    return false;
  }
}

export default function Collections() {
  const { collections, error: loaderError } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const fetcher = useFetcher();

  const [fileName, setFileName] = useState("");
  const [toastActive, setToastActive] = useState(false);
  const [toastContent, setToastContent] = useState("");
  const [toastError, setToastError] = useState(false);
  const [importErrors, setImportErrors] = useState([]);

  useEffect(() => {
    if (loaderError) {
      setToastContent(`Error loading collections: ${loaderError}`);
      setToastError(true);
      setToastActive(true);
    }
  }, [loaderError]);

  const handleDownload = useCallback(async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Collections");

    // Extract unique metafield keys and their *defined types* from the loaded collections
    const uniqueMetafields = new Map(); // key -> {key, type}
    collections.forEach(col => {
      col.metafields.nodes.forEach(mf => {
        if (!uniqueMetafields.has(mf.key)) {
          uniqueMetafields.set(mf.key, { key: mf.key, type: mf.type });
        }
      });
    });

    const metafieldKeysAndTypes = Array.from(uniqueMetafields.values()).sort((a, b) => a.key.localeCompare(b.key));
    const metafieldHeaders = metafieldKeysAndTypes.map(mt => mt.key);

    const headers = [
      "Collection ID",      // Column A (GID)
      "Title",              // Column B
      "Description",        // Column C
      "Sort Order",         // Column D
      "Template Suffix",    // Column E
      ...metafieldHeaders,  // Start from Column F
    ];
    worksheet.addRow(headers);

    collections.forEach((col, idx) => {
      if (!col.id || !col.id.startsWith('gid://shopify/Collection/')) {
        console.warn(`Collection at index ${idx} has a non-GID ID in loader data: ${col.id}. This indicates a data integrity issue or unexpected API response.`);
      }

      const metafieldMap = {};
      col.metafields.nodes.forEach(mf => {
          // When exporting, use the `displayValue` which has GIDs resolved to titles
          // BUT for `collection_reference` and `list.collection_reference`,
          // we need to export the raw GID or JSON string of GIDs.
          // This requires `loader` to pass the original `value` alongside `displayValue`.

          // Let's modify the loader to pass original `mf.value`
          // For now, if the `mf.type` is known, export the raw GID from mf.value, not displayValue.
          if (mf.type === 'collection_reference' || mf.type === 'list.collection_reference' || mf.type === 'file_reference' || mf.type === 'image_reference') {
             metafieldMap[mf.key] = mf.value || ""; // Export the raw GID(s) string
          } else {
             metafieldMap[mf.key] = mf.displayValue || ""; // Export the displayed value for other types
          }
      });


      const rowData = [
        col.id, // Collection ID (Column A) - Should be GID
        col.title, // Title (Column B)
        col.descriptionHtml, // Description (Column C)
        col.sortOrder || "", // Sort Order (Column D)
        col.templateSuffix || "", // Template Suffix (Column E)
        ...metafieldHeaders.map(key => metafieldMap[key] || ""), // Metafields (Starting from Column F)
      ];
      worksheet.addRow(rowData);
    });

    const buffer = await workbook.xlsx.writeBuffer();

    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shopify_collections_export.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, [collections]);

  const handleDrop = useCallback((files, acceptedFiles) => {
    if (acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      const formData = new FormData();
      formData.append("file", selectedFile);
      setFileName(selectedFile.name);
      setImportErrors([]);
      fetcher.submit(formData, { method: "post", encType: "multipart/form-type" });
    }
  }, [fetcher]);

  useEffect(() => {
    if (fetcher.state === "submitting") {
      setToastContent(`Importing ${fileName}... Please wait, this may take a moment.`);
      setToastError(false);
      setToastActive(true);
      setImportErrors([]);
    } else if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        setToastContent(fetcher.data.message || "Import completed successfully.");
        setToastError(false);
        setToastActive(true);
        setImportErrors([]);
      } else {
        setToastContent(fetcher.data.error || "Import failed. Check error details below.");
        setToastError(true);
        setToastActive(true);
        if (fetcher.data.errors && Array.isArray(fetcher.data.errors)) {
          setImportErrors(fetcher.data.errors);
        } else if (fetcher.data.details) {
            setImportErrors([{ row: 'N/A', message: fetcher.data.details }]);
        }
      }
    }
  }, [fetcher.data, fetcher.state, fileName]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      fetcher.load('/collections'); // Reload collections after successful import
    }
  }, [fetcher.data, fetcher.state, fetcher.load]);

  const toggleToastActive = useCallback(() => setToastActive(active => !active), []);

  const loading = navigation.state === "submitting" || fetcher.state === "submitting" || fetcher.state === "loading";

  const rows = collections.map(col => [
    col.title,
    col.handle,
    col.metafields?.nodes?.length || 0,
    new Date(col.updatedAt).toLocaleDateString(),
  ]);

  return (
    <Page title="Collections Export/Import">
      <TitleBar title="Collections Export/Import" />
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <LegacyStack spacing="tight" vertical>
              <Text variant="headingMd" as="h2">Export Collections to Excel</Text>
              <Text variant="bodyMd" as="p">Download all your Shopify collections, including their core fields and custom metafields, into an Excel file. This file can then be updated and re-imported.</Text>
              <Button onClick={handleDownload} primary disabled={loading}>
                Export Collections ({collections.length} total)
              </Button>
            </LegacyStack>
          </Card>

          <Card sectioned title="Import Updated Excel File">
            <LegacyStack spacing="tight" vertical>
              <Text variant="bodyMd" as="p">
                Upload an Excel file (exported from this app) to update existing collections and their metafields.
                <br/>
                <List type="bullet">
                  <List.Item>
                    **Crucial:** The first column (**Column A**) in your Excel file **must** contain the Shopify Global ID (`gid://shopify/Collection/123...`) for each collection.
                  </List.Item>
                  <List.Item>
                    The second column (**Column B**) is expected to be the Collection `Title`.
                  </List.Item>
                  <List.Item>
                    New metafield keys found in the Excel header (starting from **Column F**) will be created in the `custom` namespace with `single_line_text_field` type.
                  </List.Item>
                  <List.Item>
                    **Important for Metafields:** The import logic now attempts to use the metafield's defined type from Shopify. For reference types (`collection_reference`, `list.collection_reference`, `file_reference`, `image_reference`), the exported Excel will contain the raw GID(s). For `list.collection_reference`, the value must be a JSON array string of GIDs (e.g., `["gid://...","gid://..."]`).
                  </List.Item>
                  <List.Item>
                    **Please ensure any incomplete GIDs like `gid://shc` are corrected to full, valid Shopify GIDs or left empty in your Excel file.**
                  </List.Item>
                </List>
              </Text>
              <DropZone allowMultiple={false} onDrop={handleDrop} disabled={loading} accept=".xlsx">
                {fileName ? <Text>Selected file: {fileName}</Text> : <DropZone.FileUpload actionHint="Accepts .xlsx files only" />}
              </DropZone>
              {loading && <Text alignment="center" variant="bodyMd">Processing import... This may take a moment.</Text>}
            </LegacyStack>
          </Card>

          {importErrors.length > 0 && (
            <Layout.Section>
              <Card sectioned title="Import Errors Detected">
                <LegacyStack vertical spacing="tight">
                  <Text color="critical" variant="headingSm">The following issues were found during the import:</Text>
                  <DataTable
                    columnContentTypes={["text", "text"]}
                    headings={["Row #", "Error Message"]}
                    rows={importErrors.map(err => [err.row || 'N/A', err.message])}
                  />
                  <Text>Please correct these issues in your Excel file and try re-importing.</Text>
                </LegacyStack>
              </Card>
            </Layout.Section>
          )}
        </Layout.Section>

        {collections.length > 0 && (
          <Layout.Section>
            <Card title={`Existing Collections (${collections.length})`} sectioned>
              <DataTable
                columnContentTypes={["text", "text", "numeric", "text"]}
                headings={["Title", "Handle", "Metafields Count", "Updated At"]}
                rows={rows}
              />
            </Card>
          </Layout.Section>
        )}
      </Layout>

      {toastActive && (
        <Frame>
          <Toast content={toastContent} error={toastError} onDismiss={toggleToastActive} duration={5000} />
        </Frame>
      )}
    </Page>
  );
}