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
  List,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useRevalidator } from "@remix-run/react";

// --- Helper functions for validation (defined once at the top) ---
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

// Helper function for exponential backoff with GraphQL calls
async function callShopifyGraphQL(admin, query, variables, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await admin.graphql(query, { variables });
      const data = await response.json();

      // Check for GraphQL errors or specific API errors that indicate retry needed
      if (data.errors && data.errors.some(e => e.extensions?.code === 'THROTTLED' || e.message.includes('rate limit'))) {
        console.warn(`  WARNING: Rate limit hit. Retrying in ${delay / 1000}s... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
        continue; // Retry
      }
      return data; // Return successful response or non-rate-limit error
    } catch (error) {
      console.error(`  ERROR: Network error during GraphQL call (Attempt ${i + 1}/${retries}):`, error);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw error; // Re-throw after max retries
      }
    }
  }
  throw new Error("Max retries exceeded for GraphQL call.");
}

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
            id
            namespace
            key
            value
            type
          }
        }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
    }
  }
`;

const GET_COLLECTION_GIDS_BY_HANDLES_QUERY = `
  query getCollectionGidsByHandles($handles: [String!]!) {
    collections(first: 250, query: $handles.map(handle => "handle:" + handle).join(" OR ")) {
      nodes {
        id
        handle
      }
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `
  mutation collectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const COLLECTION_CREATE_MUTATION = `
  mutation collectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELDS_MUTATION = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
        type
      }
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

// NEW: Deletion Mutations
const COLLECTION_DELETE_MUTATION = `
  mutation collectionDelete($id: ID!) {
    collectionDelete(input: {id: $id}) {
      deletedCollectionId
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELD_DELETE_MUTATION = `
  mutation metafieldDelete($input: MetafieldDeleteInput!) {
    metafieldDelete(input: $input) {
      deletedId
      userErrors {
        field
        message
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

  const allMetafieldDefinitions = new Map();
  const gidsToResolve = new Set(); // Use a Set to store unique GIDs

  try {
    // First pass: Fetch all collections and collect all GIDs from reference metafields
    while (hasNextPage) {
      const data = await callShopifyGraphQL(admin, GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY, { cursor });

      if (data.errors) {
        console.error("GraphQL loader errors (GET_ALL_COLLECTIONS_WITH_METAFIELDS):", JSON.stringify(data.errors, null, 2));
        throw new Error(`Failed to fetch collections: ${data.errors.map(e => e.message).join(", ")}`);
      }

      const result = data.data.collections;
      collections.push(...result.nodes);
      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor;

      result.nodes.forEach(collection => {
        collection.metafields.nodes.forEach(mf => {
          // Store metafield definition (type and namespace) if not already seen
          // This is crucial for correctly updating metafields later in the action.
          if (!allMetafieldDefinitions.has(mf.key)) {
            allMetafieldDefinitions.set(mf.key, { type: mf.type, namespace: mf.namespace });
          }

          // Collect GIDs for resolution for reference type metafields
          if (mf.type === 'collection_reference' && typeof mf.value === 'string' && mf.value.startsWith("gid://shopify/Collection/")) {
            gidsToResolve.add(mf.value);
          } else if (mf.type === 'list.collection_reference' && typeof mf.value === 'string') {
            try {
              const parsed = JSON.parse(mf.value);
              if (Array.isArray(parsed)) {
                parsed.forEach(gid => {
                  if (typeof gid === 'string' && gid.startsWith("gid://shopify/Collection/")) {
                    gidsToResolve.add(gid);
                  }
                });
              }
            } catch (e) {
              // Ignore parsing errors for GID collection, will be handled during value conversion
            }
          }
        });
      });
    }

    // Second pass: Resolve all collected GIDs in a single (or batched) query
    const resolvedTitlesMap = new Map(); // Store GID -> Title mapping
    const uniqueGidsArray = Array.from(gidsToResolve);

    const BATCH_SIZE = 100; // Adjust based on Shopify's API limits for `nodes` query
    for (let i = 0; i < uniqueGidsArray.length; i += BATCH_SIZE) {
      const batch = uniqueGidsArray.slice(i, i + BATCH_SIZE);
      if (batch.length === 0) continue; // Skip empty batches

      try {
        const result = await callShopifyGraphQL(admin, GET_COLLECTION_TITLES_QUERY, { ids: batch });

        if (result.errors) {
          console.error("GraphQL loader (GET_COLLECTION_TITLES) errors for batch GIDs:", JSON.stringify(result.errors, null, 2));
          // Don't throw, just log and continue, specific metafields will show "Error resolving"
        } else {
          for (const node of result.data.nodes) {
            if (node && node.id && node.title) {
              resolvedTitlesMap.set(node.id, node.title);
            }
          }
        }
      } catch (error) {
        console.error(`Error resolving GID batch (starting at index ${i}):`, error);
        // Continue to next batch even if one fails
      }
    }

    // Third pass: Iterate through collections again to set displayValue using the resolvedTitlesMap
    for (const collection of collections) {
      collection.type = collection.ruleSet ? "Smart" : "Manual";
      collection.exportedRules = collection.ruleSet?.rules || [];

      for (const metafield of collection.metafields.nodes) {
        if (metafield.type === 'list.collection_reference' && typeof metafield.value === 'string') {
          let gids = [];
          try {
            const parsed = JSON.parse(metafield.value);
            if (Array.isArray(parsed)) gids = parsed;
          } catch (e) {
            gids = []; // Invalid JSON
          }
          metafield.displayValue = gids
            .filter(gid => typeof gid === 'string' && gid.startsWith("gid://shopify/Collection/"))
            .map(gid => resolvedTitlesMap.get(gid) || `[Invalid GID: ${gid}]`)
            .join(", ");
        } else if (metafield.type === 'collection_reference' && typeof metafield.value === 'string' && metafield.value.startsWith("gid://shopify/Collection/")) {
          metafield.displayValue = resolvedTitlesMap.get(metafield.value) || `[Invalid GID: ${metafield.value}]`;
        } else {
          metafield.displayValue = metafield.value;
        }
      }
    }
  } catch (error) {
    console.error("Error in collections loader:", error);
    return json({ collections: [], error: error.message || "Failed to load collections." }, { status: 500 });
  }

  // Convert the Map to a plain object for JSON serialization
  return json({ collections, metafieldDefinitions: Object.fromEntries(allMetafieldDefinitions) });
};

// --- Action (Import) ---

function convertValueForShopifyType(value, type) {
  // If the value is truly empty or undefined
  if (value === null || value === undefined || (typeof value === 'string' && String(value).trim() === "")) {
    switch (type) {
      case "json":
        return "{}"; // Send empty JSON object string instead of null
      case "rich_text":
        // Empty rich text is typically an empty blocks array
        return JSON.stringify({ "blocks": [{ "type": "paragraph", "children": [{ "text": "" }] }] });
      case "list.collection_reference":
      case "list.file_reference":
      case "list.image_reference":
      case "list.product_reference":
      case "list.page_reference":
      case "list.url":
        return "[]"; // Send empty JSON array string for lists instead of null
      case "boolean":
        return false; // Default to false if no value is provided
      case "collection_reference":
      case "file_reference":
      case "image_reference":
      case "product_reference":
      case "page_reference":
      case "url":
      case "date":
      case "date_time":
        return ""; // Send empty string for these types when clearing
      default:
        return ""; // For all other types, empty string to clear
    }
  }

  const stringValue = String(value);

  switch (type) {
    case "number_integer":
      const intValue = parseInt(stringValue, 10);
      return isNaN(intValue) ? null : String(intValue);
    case "number_decimal":
      const decimalValue = parseFloat(stringValue);
      return isNaN(decimalValue) ? null : String(decimalValue);
    case "boolean":
      // Handle "Any"/"All" from export, and standard "true"/"false" or "1"/"0"
      if (stringValue.toLowerCase() === "any") return true; // maps "Any" to true
      if (stringValue.toLowerCase() === "all") return false; // maps "All" to false
      return stringValue.toLowerCase() === "true" || stringValue === "1" || stringValue.toLowerCase() === "yes";
    case "json":
    case "dimension":
    case "volume":
    case "weight":
    case "rating":
      // Value must be a string that represents valid JSON
      try {
        JSON.parse(stringValue);
        return stringValue;
      } catch (e) {
        console.warn(`Invalid JSON format for metafield type '${type}': "${stringValue}". Returning empty object string.`);
        return "{}"; // Return empty object string if invalid JSON
      }
    case "rich_text":
      // If it's already valid JSON (likely from a previous export), use it.
      // Otherwise, assume it's plain text and convert to Shopify's rich_text JSON format.
      try {
        JSON.parse(stringValue);
        return stringValue;
      } catch (e) {
        // Fallback for plain text: convert to rich_text JSON format
        return JSON.stringify({
          "blocks": [
            {
              "type": "paragraph",
              "children": [
                { "text": stringValue }
              ]
            }
          ]
        });
      }
    case "date":
      // Excel dates are numbers (days since 1900-01-01). Handle both number and string formats.
      if (typeof value === 'number') {
        const date = new Date(Math.round((value - 25569) * 86400 * 1000)); // Convert Excel serial date to JS Date
        return date.toISOString().split('T')[0]; // Format to YYYY-MM-DD
      }
      // If it's a string, attempt to parse and format
      const dateParse = new Date(stringValue);
      return isNaN(dateParse.getTime()) ? "" : dateParse.toISOString().split('T')[0];
    case "date_time":
      // Excel dates are numbers. Handle both number and string formats.
      if (typeof value === 'number') {
        const dateTime = new Date(Math.round((value - 25569) * 86400 * 1000));
        return dateTime.toISOString(); // Full ISO format
      }
      // If it's a string, attempt to parse and format
      const dateTimeParse = new Date(stringValue);
      return isNaN(dateTimeParse.getTime()) ? "" : dateTimeParse.toISOString();
    case "url":
      if (!isValidUrl(stringValue)) {
        console.warn(`Invalid URL for metafield type 'url': "${stringValue}". Returning empty string.`);
        return ""; // Return empty string for invalid URLs
      }
      return stringValue;
    case "collection_reference":
      // Expects a single GID string, assumed to be resolved already
      return stringValue.startsWith("gid://shopify/Collection/") ? stringValue : "";
    case "list.collection_reference":
      // Expects a JSON array string of GIDs, assumed to be resolved already
      try {
        const parsed = JSON.parse(stringValue);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && item.startsWith("gid://shopify/Collection/"))) {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        console.warn(`Invalid JSON or GID format for list.collection_reference: "${stringValue}". Returning empty array string.`);
      }
      return "[]"; // Return empty array string if invalid JSON or GID format
    case "file_reference":
    case "image_reference":
      // Expects a single GID string
      return stringValue.startsWith("gid://shopify/File/") || stringValue.startsWith("gid://shopify/MediaImage/") ? stringValue : "";
    case "list.file_reference":
    case "list.image_reference":
      // Expects a JSON array string of GIDs
      try {
        const parsed = JSON.parse(stringValue);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && (item.startsWith("gid://shopify/File/") || item.startsWith("gid://shopify/MediaImage/")))) {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        console.warn(`Invalid JSON or GID format for list.file_reference/image_reference: "${stringValue}". Returning empty array string.`);
      }
      return "[]";
    default:
      return stringValue; // For generic text fields, return the string value directly
  }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  if (!session) {
    console.error("Action Error: Authentication required.");
    return json({ success: false, error: "Authentication required.", status: 401 }, { status: 401 });
  }

  const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 50_000_000 }); // 50 MB
  let formData;
  try {
    formData = await unstable_parseMultipartFormData(request, uploadHandler);
  } catch (error) {
    console.error("Action Error: Error parsing multipart form data:", error);
    return json({ success: false, error: "Failed to parse file upload. File might be too large or corrupted.", details: error.message }, { status: 400 });
  }

  const file = formData.get("file");

  if (!file || !(file instanceof Blob)) {
    console.error("Action Error: No file uploaded or invalid file type.");
    return json({ success: false, error: "No file uploaded or invalid file type. Please upload an Excel (.xlsx) file.", status: 400 }, { status: 400 });
  }

  let workbook;
  let worksheet;
  let headerRowValues;
  let collectionsData;
  try {
    // This is the CRUCIAL data for deletion logic: all existing collections and metafields.
    collectionsData = JSON.parse(formData.get("collectionsData"));
  } catch (e) {
    console.error("Action Error: Failed to parse collectionsData from form data:", e);
    return json({ success: false, error: "Internal error: Failed to parse initial collection data.", status: 500 });
  }
  const allCollectionsFromLoader = collectionsData.collections || [];
  const originalMetafieldDefinitionsMap = collectionsData.metafieldDefinitions || {};
  console.log("Action Start: Loader-provided Metafield Definitions:", JSON.stringify(originalMetafieldDefinitionsMap, null, 2));


  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    worksheet = workbook.worksheets[0];

    if (!worksheet) {
      console.error("Action Error: Excel file is empty or invalid format. No worksheet found.");
      return json({ success: false, error: "Excel file is empty or invalid format. No worksheet found.", status: 400 });
    }

    headerRowValues = worksheet.getRow(1).values;
    // ExcelJS `values` returns an array where index 0 is null/undefined and actual values start from index 1.
    // Filter out null/undefined values to get actual headers.
    const filteredHeaderRowValues = headerRowValues.filter(h => h !== null && h !== undefined && String(h).trim() !== '');

    // Expected minimal headers
    if (!filteredHeaderRowValues || filteredHeaderRowValues.length < 7) {
      console.error("Action Error: Excel file is missing expected header columns.");
      return json({ success: false, error: "Excel file is missing expected header columns (Collection ID, Title, Description, Sort Order, Template Suffix, Collection Type, Smart Collection: Applied Disjunctively).", status: 400 });
    }

  } catch (error) {
    console.error("Action Error: Error reading Excel file:", error);
    return json({ success: false, error: `Failed to read Excel file: ${error.message}. Ensure it's a valid .xlsx format.`, status: 400 }, { status: 400 });
  }

  let errors = [];
  let processedRowsCount = 0;
  let updatedCollectionsCount = 0;
  let createdCollectionsCount = 0;
  let updatedMetafieldsCount = 0;

  // Identify column indices dynamically for robustness
  const headerMap = new Map(); // Header Name -> Column Index (1-based from ExcelJS)
  headerRowValues.forEach((h, idx) => {
    if (typeof h === 'string' && h.trim() !== '') {
      headerMap.set(h.trim(), idx);
    }
  });

  const getCellVal = (row, header) => {
    const colIndex = headerMap.get(header);
    return colIndex ? row.getCell(colIndex)?.value : undefined;
  };

  const handlesToResolve = new Set();
  // NEW: Store IDs and handles from the import file to determine what to delete later
  const importedCollectionHandles = new Set();
  const importedCollectionIds = new Set();

  // Pre-process all rows to collect collection handles from metafields
  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    const id = String(getCellVal(row, "Collection ID") || '').trim();
    const title = String(getCellVal(row, "Title") || '').trim();

    // NEW: Add collections from the import file to our sets
    if (id && id.startsWith("gid://shopify/Collection/")) {
      importedCollectionIds.add(id);
    }
    const derivedHandle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-*|-*$/g, '');
    if (derivedHandle) {
      importedCollectionHandles.add(derivedHandle);
    }


    for (const [header, colIndex] of headerMap.entries()) {
      if (
        ["Collection ID", "Title", "Description", "Sort Order", "Template Suffix", "Collection Type", "Smart Collection: Applied Disjunctively"].includes(header) ||
        /^Rule \d+ - (Column|Relation|Condition)$/.test(header)
      ) {
        continue;
      }

      const rawValue = row.getCell(colIndex)?.value;
      const key = header;
      const existingMetafieldDef = originalMetafieldDefinitionsMap[key];
      const shopifyDefinedType = existingMetafieldDef?.type; // Only proceed if type is explicitly defined

      if (shopifyDefinedType === 'collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        // Only add if it's not already a GID
        if (!String(rawValue).trim().startsWith("gid://shopify/Collection/")) {
          handlesToResolve.add(String(rawValue).trim());
        }
      } else if (shopifyDefinedType === 'list.collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        try {
          // If it's a JSON array, parse it and check each item.
          const parsed = JSON.parse(String(rawValue));
          if (Array.isArray(parsed)) {
            parsed.forEach(item => {
              if (typeof item === 'string' && item.trim() !== '' && !item.trim().startsWith("gid://shopify/Collection/")) {
                handlesToResolve.add(item.trim());
              }
            });
          } else {
            // If not valid JSON, assume comma-separated
            String(rawValue).split(',').map(s => s.trim()).filter(Boolean).forEach(handle => {
              if (!handle.startsWith("gid://shopify/Collection/")) {
                handlesToResolve.add(handle);
              }
            });
          }
        } catch (e) {
          // If not valid JSON, treat as comma-separated or single handle
          String(rawValue).split(',').map(s => s.trim()).filter(Boolean).forEach(handle => {
            if (!handle.startsWith("gid://shopify/Collection/")) {
              handlesToResolve.add(handle);
            }
          });
        }
      }
    }
  }

  const handleToGidMap = new Map();
  const uniqueHandlesArray = Array.from(handlesToResolve);

  // Resolve handles to GIDs
  if (uniqueHandlesArray.length > 0) {
    const BATCH_QUERY_SIZE = 100; // Limit for handles in a single query
    for (let i = 0; i < uniqueHandlesArray.length; i += BATCH_QUERY_SIZE) {
      const batchHandles = uniqueHandlesArray.slice(i, i + BATCH_QUERY_SIZE);
      try {
        const queryStrings = batchHandles.map(handle => `handle:${JSON.stringify(handle)}`);
        const query = queryStrings.join(" OR ");
        console.log(`  DEBUG: Resolving handles batch (startIndex: ${i}). Query: ${query}`);

        const response = await callShopifyGraphQL(admin, `
          query getCollectionGidsByHandles($query: String!) {
            collections(first: 250, query: $query) {
              nodes {
                id
                handle
              }
            }
          }
        `, {
          query,
        });

        const result = response; // Already parsed by callShopifyGraphQL
        if (result.errors) {
          console.error(`  ERROR: GraphQL errors resolving handles batch (starting at index ${i}):`, JSON.stringify(result.errors, null, 2));
          // Continue, specific handles will not be resolved
        } else {
          for (const node of result.data.collections.nodes) {
            if (node && node.id && node.handle) {
              handleToGidMap.set(node.handle, node.id);
            }
          }
          console.log(`  DEBUG: Resolved handles batch. Found ${result.data.collections.nodes.length} GIDs.`);
        }
      } catch (error) {
        console.error(`  ERROR: Error resolving handles batch (starting at index ${i}):`, error);
      }
    }
  }

  // Before the main loop, fetch all existing collections by handle for upsert logic
  const existingCollectionsMap = new Map(); // handle -> GID
  let existingCollectionsCursor = null;
  let hasMoreExistingCollections = true;

  try {
      while (hasMoreExistingCollections) {
          const response = await callShopifyGraphQL(admin, `
              query getAllCollectionHandles($cursor: String) {
                  collections(first: 250, after: $cursor) {
                      pageInfo {
                          hasNextPage
                          endCursor
                      }
                      nodes {
                          id
                          handle
                      }
                  }
              }
          `, { cursor: existingCollectionsCursor });

          if (response.errors) {
              console.error("GraphQL loader errors (getAllCollectionHandles):", JSON.stringify(response.errors, null, 2));
              throw new Error(`Failed to fetch existing collection handles: ${response.errors.map(e => e.message).join(", ")}`);
          }

          const result = response.data.collections;
          result.nodes.forEach(col => {
              if (col.handle) {
                  existingCollectionsMap.set(col.handle, col.id);
              }
          });
          hasMoreExistingCollections = result.pageInfo.hasNextPage;
          existingCollectionsCursor = result.pageInfo.endCursor;
      }
      console.log(`  DEBUG: Fetched ${existingCollectionsMap.size} existing collection handles for upsert logic.`);
  } catch (error) {
      console.error("Error fetching existing collection handles:", error);
      return json({ success: false, error: error.message || "Failed to load existing collections for upsert.", status: 500 });
  }


  // Main import loop
  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    const id = String(getCellVal(row, "Collection ID") || '').trim();
    const title = String(getCellVal(row, "Title") || '').trim();
    const descriptionHtml = String(getCellVal(row, "Description") || '').trim();
    const sortOrderRaw = getCellVal(row, "Sort Order");
    const templateSuffix = String(getCellVal(row, "Template Suffix") || '').trim() || null;
    const collectionType = String(getCellVal(row, "Collection Type") || '').trim().toLowerCase();
    const appliedDisjunctivelyRaw = getCellVal(row, "Smart Collection: Applied Disjunctively");

    console.log(`\n--- Processing Row ${rowIndex} ---`);
    console.log(`  Row ${rowIndex}: Collection ID from Excel: "${id}", Title from Excel: "${title}"`);

    // Determine if it's an update or create operation
    let targetCollectionId = id; // This will hold the GID of the collection to update metafields on
    let mutationType = "create"; // Default to create

    if (id && id.startsWith("gid://shopify/Collection/")) {
        // If an ID is provided and it's a valid GID, it's an update
        mutationType = "update";
        targetCollectionId = id;
        console.log(`  Row ${rowIndex}: Collection ID provided, determined operation type: "${mutationType}".`);
    } else {
        // If no valid GID is provided, try to find an existing collection by matching its handle
        // Derive handle from title (Shopify's default behavior for new collections)
        const derivedHandle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-*|-*$/g, '');
        const existingGidByHandle = existingCollectionsMap.get(derivedHandle);
        if (existingGidByHandle) {
            mutationType = "update";
            targetCollectionId = existingGidByHandle;
            console.log(`  Row ${rowIndex}: No Collection ID provided, but found existing collection by derived handle "${derivedHandle}" (GID: ${targetCollectionId}). Determined operation type: "${mutationType}".`);
        } else {
            mutationType = "create";
            targetCollectionId = null; // Will be populated after creation
            console.log(`  Row ${rowIndex}: No Collection ID provided and no existing collection found by derived handle. Determined operation type: "${mutationType}".`);
        }
    }

    // Validate Collection ID for update operations (after upsert logic)
    if (mutationType === "update" && (!targetCollectionId || !targetCollectionId.startsWith("gid://shopify/Collection/"))) {
      const msg = `Invalid Collection ID for update in Column 'Collection ID' or resolution by handle failed. Expected format: 'gid://shopify/Collection/12345'. Found: "${id || 'EMPTY'}". Skipping update for this row.`;
      errors.push({ row: rowIndex, message: msg });
      console.error(`  Row ${rowIndex}: ${msg}`);
      continue;
    }

    // Validate if title is present for new collections
    if (mutationType === "create" && !title) {
        const msg = "Skipping row: Title is empty for a new collection. Cannot create collection without a title.";
        errors.push({ row: rowIndex, message: msg });
        console.error(`  Row ${rowIndex}: ${msg}`);
        continue;
    }


    const collectionInput = {
      title,
      descriptionHtml,
    };

    if (sortOrderRaw) {
      const sortOrder = String(sortOrderRaw).toUpperCase().trim();
      const validSortOrders = ['ALPHA_ASC', 'ALPHA_DESC', 'BEST_SELLING', 'CREATED', 'MANUAL', 'PRICE_ASC', 'PRICE_DESC'];
      if (validSortOrders.includes(sortOrder)) {
        collectionInput.sortOrder = sortOrder;
      } else {
        const msg = `Invalid Sort Order value: "${sortOrderRaw}". Must be one of: ${validSortOrders.join(", ")}. Skipping sortOrder update.`;
        errors.push({ row: rowIndex, message: msg });
        console.warn(`  Row ${rowIndex}: ${msg}`);
      }
    }

    collectionInput.templateSuffix = templateSuffix;

    // --- Smart Collection RuleSet Handling ---
    if (collectionType === 'smart') {
      const rules = [];
      const validRuleColumns = ['TAG', 'TITLE', 'TYPE', 'VENDOR', 'VARIANT_COMPARE_AT_PRICE', 'VARIANT_PRICE', 'VARIANT_WEIGHT'];
      const validRuleRelations = ['CONTAINS', 'ENDS_WITH', 'EQUALS', 'GREATER_THAN', 'IS_NOT_SET', 'IS_SET', 'LESS_THAN', 'NOT_CONTAINS', 'NOT_EQUALS', 'STARTS_WITH'];

      let ruleIndex = 1;
      while (headerMap.has(`Rule ${ruleIndex} - Column`)) {
        const column = String(getCellVal(row, `Rule ${ruleIndex} - Column`) || '').trim();
        const relation = String(getCellVal(row, `Rule ${ruleIndex} - Relation`) || '').trim();
        const condition = getCellVal(row, `Rule ${ruleIndex} - Condition`);

        // Validate column and relation against Shopify's allowed enums
        const isColumnValid = validRuleColumns.includes(column);
        const isRelationValid = validRuleRelations.includes(relation);

        if (column && relation && condition !== undefined && String(condition).trim() !== '') {
          if (isColumnValid && isRelationValid) {
            rules.push({ column, relation, condition: String(condition) });
          } else {
            let validationMessage = `Invalid rule ${ruleIndex}: `;
            if (!isColumnValid) {
              validationMessage += `Column "${column}" is not valid. Must be one of: ${validRuleColumns.join(", ")}. `;
            }
            if (!isRelationValid) {
              validationMessage += `Relation "${relation}" is not valid. Must be one of: ${validRuleRelations.join(", ")}. `;
            }
            errors.push({ row: rowIndex, message: validationMessage.trim() });
            console.warn(`  Row ${rowIndex}: ${validationMessage.trim()}`);
          }
        } else if (column || relation || (condition !== undefined && String(condition).trim() !== '')) {
          const msg = `Incomplete rule ${ruleIndex} for smart collection. All of 'Column', 'Relation', 'Condition' must be present and non-empty for rule ${ruleIndex}.`;
          errors.push({ row: rowIndex, message: msg });
          console.warn(`  Row ${rowIndex}: ${msg}`);
        }
        ruleIndex++;
      }

      if (rules.length > 0) {
        const appliedDisjunctivelyBoolean = String(appliedDisjunctivelyRaw || '').toLowerCase() === 'any';
        collectionInput.ruleSet = {
          appliedDisjunctively: appliedDisjunctivelyBoolean,
          rules: rules,
        };
        console.log(`  Row ${rowIndex}: Smart collection rules processed: ${rules.length} rules, Applied Disjunctively: ${appliedDisjunctivelyBoolean}.`);
      } else {
        const msg = `Collection type is 'Smart' but no valid rules were found. Smart collections require at least one rule. This collection will be treated as Manual.`;
        errors.push({ row: rowIndex, message: msg });
        collectionInput.ruleSet = null; // Ensure ruleSet is null for Manual
        console.warn(`  Row ${rowIndex}: ${msg}`);
      }
    } else {
      collectionInput.ruleSet = null; // Explicitly set ruleSet to null for Manual collections
      console.log(`  Row ${rowIndex}: Collection type is 'Manual'. RuleSet set to null.`);
    }

    // --- Perform Collection Update or Create ---
    try {
      let mutationResult;

      if (mutationType === "update") {
        const updateInput = { ...collectionInput, id: targetCollectionId };
        console.log(`  Row ${rowIndex}: Attempting to UPDATE existing collection with ID: ${targetCollectionId}. Input:`, JSON.stringify(updateInput, null, 2));
        mutationResult = await callShopifyGraphQL(admin, COLLECTION_UPDATE_MUTATION, {
          input: updateInput,
        });

        if (mutationResult.data?.collectionUpdate?.userErrors?.length > 0) {
          const userErrors = mutationResult.data.collectionUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join("; ");
          const msg = `Collection update errors: ${userErrors}`;
          errors.push({ row: rowIndex, message: msg });
          console.error(`  Row ${rowIndex}: ${msg}`);
          targetCollectionId = null; // Mark as failed to prevent metafield update
        } else if (mutationResult.errors) {
          const graphQLErrors = JSON.stringify(mutationResult.errors.map(e => e.message).join(", "));
          const msg = `Collection update GraphQL errors: ${graphQLErrors}`;
          errors.push({ row: rowIndex, message: msg });
          console.error(`  Row ${rowIndex}: ${msg}`);
          targetCollectionId = null;
        } else {
          updatedCollectionsCount++;
          console.log(`  Row ${rowIndex}: Successfully updated collection ID: ${targetCollectionId}`);
          targetCollectionId = mutationResult.data.collectionUpdate.collection.id; // Confirm ID
        }
      } else { // Create
        console.log(`  Row ${rowIndex}: Attempting to CREATE new collection. Input:`, JSON.stringify(collectionInput, null, 2));
        mutationResult = await callShopifyGraphQL(admin, COLLECTION_CREATE_MUTATION, {
          input: collectionInput,
        });

        if (mutationResult.data?.collectionCreate?.userErrors?.length > 0) {
          const userErrors = mutationResult.data.collectionCreate.userErrors.map(e => `${e.field}: ${e.message}`).join("; ");
          const msg = `Collection creation errors: ${userErrors}`;
          errors.push({ row: rowIndex, message: msg });
          console.error(`  Row ${rowIndex}: ${msg}`);
          targetCollectionId = null;
        } else if (mutationResult.errors) {
          const graphQLErrors = JSON.stringify(mutationResult.errors.map(e => e.message).join(", "));
          const msg = `Collection creation GraphQL errors: ${graphQLErrors}`;
          errors.push({ row: rowIndex, message: msg });
          console.error(`  Row ${rowIndex}: ${msg}`);
          targetCollectionId = null;
        } else {
          createdCollectionsCount++;
          const newCollectionId = mutationResult.data.collectionCreate.collection.id;
          if (newCollectionId) {
            targetCollectionId = newCollectionId; // Crucial: use the newly created ID for metafields
            // Update existingCollectionsMap with the newly created collection's handle and GID
            const newCollectionHandle = mutationResult.data.collectionCreate.collection.handle; // Assuming handle is returned on create
            if (newCollectionHandle) {
                existingCollectionsMap.set(newCollectionHandle, newCollectionId);
                console.log(`  Row ${rowIndex}: Added new collection handle "${newCollectionHandle}" to upsert map.`);
            }
            console.log(`  Row ${rowIndex}: Successfully created new collection, ID: ${newCollectionId}`);
          } else {
            const msg = `Collection created but no ID returned.`;
            errors.push({ row: rowIndex, message: msg });
            console.error(`  Row ${rowIndex}: ${msg}`);
            targetCollectionId = null;
          }
        }
      }

    } catch (e) {
      console.error(`  ERROR: Error ${mutationType} collection "${title}" (row ${rowIndex}):`, e);
      errors.push({ row: rowIndex, message: `Collection ${mutationType} failed for "${title}": ${e.message}` });
      targetCollectionId = null; // Mark as failed
      continue; // Skip metafield update if collection failed to create/update
    }


    // --- Metafields Update AND DELETION Logic ---
    if (!targetCollectionId) {
      const msg = `Skipping metafield updates for "${title}" as collection ID is not available after collection operation.`;
      errors.push({ row: rowIndex, message: msg });
      console.error(`  Row ${rowIndex}: ${msg}`);
      continue;
    }
    console.log(`  Row ${rowIndex}: Collection successfully ${mutationType}d, actual ID to use for metafields: ${targetCollectionId}. Preparing metafields.`);


    const metafieldsToSet = [];
    const metafieldKeysInExcel = new Set(); // NEW: To track metafields in the current Excel row

    for (const [header, colIndex] of headerMap.entries()) {
      // Skip standard columns (Collection ID, Title, etc.)
      if (
        ["Collection ID", "Title", "Description", "Sort Order", "Template Suffix", "Collection Type", "Smart Collection: Applied Disjunctively"].includes(header) ||
        /^Rule \d+ - (Column|Relation|Condition)$/.test(header)
      ) {
        continue;
      }

      const rawValue = row.getCell(colIndex)?.value;
      const key = header;
      metafieldKeysInExcel.add(key); // NEW: Add this key to the set for deletion comparison

      // Determine the metafield's defined type and namespace from loader data
      const existingMetafieldDef = originalMetafieldDefinitionsMap[key];
      // Default to single_line_text_field if no definition is found in the loader data,
      // and 'custom' namespace. This is the fallback for new metafields or unknown ones.
      const shopifyDefinedType = existingMetafieldDef?.type || "single_line_text_field";
      const metafieldNamespace = existingMetafieldDef?.namespace || "custom";

      console.log(`    Row ${rowIndex}, Metafield: "${key}". Raw Value: "${rawValue}"`);
      console.log(`    Expected Type (from loader): "${existingMetafieldDef?.type || 'N/A'}", Expected Namespace (from loader): "${existingMetafieldDef?.namespace || 'N/A'}"`);
      console.log(`    Actual Type used for API: "${shopifyDefinedType}", Actual Namespace used for API: "${metafieldNamespace}"`);

      if (!existingMetafieldDef) {
        console.warn(`    WARNING: Row ${rowIndex}, Metafield "${key}": No existing metafield definition found in loader data for this key. Defaulting to type: "${shopifyDefinedType}", namespace: "${metafieldNamespace}". This might cause issues if a different type/namespace is intended for an existing metafield.`);
      }

      let valueToConvert = rawValue;

      // Perform handle-to-GID conversion for collection references
      if (shopifyDefinedType === 'collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        const handle = String(rawValue).trim();
        if (!handle.startsWith("gid://shopify/Collection/")) {
          const resolvedGid = handleToGidMap.get(handle);
          if (resolvedGid) {
            valueToConvert = resolvedGid;
            console.log(`    Row ${rowIndex}, Metafield "${key}": Resolved handle "${handle}" to GID "${resolvedGid}".`);
          } else {
            const msg = `Metafield '${key}' (type: ${shopifyDefinedType}): Could not resolve collection handle "${handle}" to a GID. Skipping this metafield.`;
            errors.push({ row: rowIndex, message: msg });
            console.warn(`    Row ${rowIndex}, ${msg}`);
            continue; // Skip this metafield if handle not resolved
          }
        } else {
          console.log(`    Row ${rowIndex}, Metafield "${key}": Value "${handle}" is already a GID.`);
        }
      } else if (shopifyDefinedType === 'list.collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        let handles = [];
        try {
          const parsed = JSON.parse(String(rawValue)); // Try parsing as JSON array first
          if (Array.isArray(parsed)) {
            handles = parsed.map(String).filter(Boolean).map(h => h.trim());
            console.log(`    Row ${rowIndex}, Metafield "${key}": Parsed value as JSON array: ${JSON.stringify(handles)}`);
          } else {
            // If not JSON array, assume comma-separated
            handles = String(rawValue).split(',').map(s => s.trim()).filter(Boolean);
            console.log(`    Row ${rowIndex}, Metafield "${key}": Parsed value as comma-separated handles: ${JSON.stringify(handles)}`);
          }
        } catch (e) {
          // If JSON parsing fails, treat as comma-separated
          handles = String(rawValue).split(',').map(s => s.trim()).filter(Boolean);
          console.log(`    Row ${rowIndex}, Metafield "${key}": JSON parse failed, treating as comma-separated handles: ${JSON.stringify(handles)}`);
        }

        const resolvedGids = [];
        let allHandlesResolved = true;
        for (const handle of handles) {
          if (handle.startsWith("gid://shopify/Collection/")) {
            resolvedGids.push(handle);
            console.log(`    Row ${rowIndex}, Metafield "${key}": List item "${handle}" is already a GID.`);
          } else {
            const resolvedGid = handleToGidMap.get(handle);
            if (resolvedGid) {
              resolvedGids.push(resolvedGid);
              console.log(`    Row ${rowIndex}, Metafield "${key}": Resolved list handle "${handle}" to GID "${resolvedGid}".`);
            } else {
              const msg = `Metafield '${key}' (type: ${shopifyDefinedType}): Could not resolve collection handle "${handle}" to a GID. This list item will be skipped.`;
              errors.push({ row: rowIndex, message: msg });
              console.warn(`    Row ${rowIndex}, ${msg}`);
              allHandlesResolved = false;
            }
          }
        }
        if (allHandlesResolved) {
          valueToConvert = JSON.stringify(resolvedGids);
          console.log(`    Row ${rowIndex}, Metafield "${key}": Final value for API (list): "${valueToConvert}"`);
        } else {
          console.warn(`    Row ${rowIndex}, Metafield "${key}": Skipping this list metafield as not all handles could be resolved.`);
          continue; // Skip this metafield if any handle in the list could not be resolved
        }
      }

      const valueForApi = convertValueForShopifyType(valueToConvert, shopifyDefinedType);
      console.log(`    Row ${rowIndex}, Metafield "${key}": Converted value for API: "${valueForApi}" (type: ${typeof valueForApi})`);

      // Add to metafieldsToSet only if valueForApi is not undefined (it means conversion was attempted)
      // `null` for valueForApi is intended to clear a metafield
      if (valueForApi !== undefined) {
        metafieldsToSet.push({
          ownerId: targetCollectionId,
          namespace: metafieldNamespace,
          key: key,
          type: shopifyDefinedType,
          value: valueForApi !== null ? String(valueForApi) : null, // Ensure value is string or null
        });
      }
    }

    // NEW METAFIELD DELETION LOGIC
    const existingCollectionFromLoader = allCollectionsFromLoader.find(c => c.id === targetCollectionId);
    if (existingCollectionFromLoader) {
      for (const existingMetafield of existingCollectionFromLoader.metafields.nodes) {
        // If the existing metafield's key is NOT in the Excel file headers, delete it.
        if (!metafieldKeysInExcel.has(existingMetafield.key)) {
          console.log(`  Row ${rowIndex}, Collection ${targetCollectionId}: Deleting metafield '${existingMetafield.namespace}.${existingMetafield.key}' as it was not found in the import file.`);
          try {
            await callShopifyGraphQL(admin, METAFIELD_DELETE_MUTATION, {
              input: { id: existingMetafield.id }
            });
            updatedMetafieldsCount++; // Count as a "deleted" update
          } catch (e) {
            console.error(`  ERROR: Failed to delete metafield '${existingMetafield.id}':`, e);
            errors.push({ row: rowIndex, message: `Failed to delete old metafield '${existingMetafield.key}': ${e.message}` });
          }
        }
      }
    }

    if (metafieldsToSet.length > 0) {
      try {
        console.log(`  DEBUG: Attempting to set ${metafieldsToSet.length} metafield(s) for collection ID: ${targetCollectionId} (Row ${rowIndex})`);
        console.log("  DEBUG: Metafields payload for API:", JSON.stringify(metafieldsToSet, null, 2));

        const metafieldResult = await callShopifyGraphQL(admin, SET_METAFIELDS_MUTATION, {
          metafields: metafieldsToSet,
        });

        if (metafieldResult.errors) {
          const graphQLErrors = JSON.stringify(metafieldResult.errors.map(e => e.message).join(", "));
          const msg = `Metafield update GraphQL errors: ${graphQLErrors}`;
          console.error(`  ERROR: Metafield update GraphQL errors for row ${rowIndex}: ${graphQLErrors}`);
          errors.push({ row: rowIndex, message: msg });
        } else if (metafieldResult.data?.metafieldsSet?.userErrors?.length) {
          const userErrors = metafieldResult.data.metafieldsSet.userErrors.map(e => `${e.field}: ${e.message}`).join("; ");
          const msg = `Metafield update user errors: ${userErrors}`;
          console.error(`  ERROR: Metafield update user errors for row ${rowIndex}: ${userErrors}`);
          errors.push({ row: rowIndex, message: msg });
        } else if (metafieldResult.data?.metafieldsSet?.metafields?.length) {
          updatedMetafieldsCount += metafieldResult.data.metafieldsSet.metafields.length;
          console.log(`  Successfully updated ${metafieldResult.data.metafieldsSet.metafields.length} metafields for collection ${targetCollectionId} (Row ${rowIndex}).`);
        } else {
            console.log(`  No metafields explicitly returned as updated for collection ${targetCollectionId} (Row ${rowIndex}). This might mean no changes or an empty result.`);
        }
      } catch (e) {
        console.error(`  Network or unexpected error updating metafields for collection ${targetCollectionId} (row ${rowIndex}):`, e);
        errors.push({ row: rowIndex, message: `Metafield update failed for ID ${targetCollectionId}: ${e.message}` });
      }
    } else {
        console.log(`  No metafields to set for collection ${targetCollectionId} (Row ${rowIndex}).`);
    }
    processedRowsCount++;
  }

  // NEW DELETION LOGIC FOR COLLECTIONS
  let deletedCollectionsCount = 0;
  console.log("\n--- Starting Collection Deletion Phase ---");
  for (const collectionFromLoader of allCollectionsFromLoader) {
    const isPresentInExcelById = importedCollectionIds.has(collectionFromLoader.id);
    const isPresentInExcelByHandle = importedCollectionHandles.has(collectionFromLoader.handle);
    
    // A collection is a candidate for deletion if it exists in the loader data
    // but is NOT present in the list of GIDs or Handles from the Excel file.
    if (!isPresentInExcelById && !isPresentInExcelByHandle) {
      console.log(`  Deleting collection '${collectionFromLoader.title}' (ID: ${collectionFromLoader.id}) as it was not found in the import file.`);
      try {
        const deleteResult = await callShopifyGraphQL(admin, COLLECTION_DELETE_MUTATION, {
          id: collectionFromLoader.id
        });
        if (deleteResult.data?.collectionDelete?.userErrors?.length) {
          const userErrors = deleteResult.data.collectionDelete.userErrors.map(e => `${e.field}: ${e.message}`).join("; ");
          console.error(`  ERROR: Failed to delete collection '${collectionFromLoader.title}': ${userErrors}`);
          errors.push({ row: 'N/A', message: `Collection deletion failed for '${collectionFromLoader.title}': ${userErrors}` });
        } else if (deleteResult.errors) {
          const graphQLErrors = JSON.stringify(deleteResult.errors.map(e => e.message).join(", "));
          console.error(`  ERROR: Failed to delete collection '${collectionFromLoader.title}': GraphQL errors: ${graphQLErrors}`);
          errors.push({ row: 'N/A', message: `Collection deletion failed for '${collectionFromLoader.title}': ${graphQLErrors}` });
        } else {
          deletedCollectionsCount++;
          console.log(`  Successfully deleted collection '${collectionFromLoader.title}' (ID: ${deleteResult.data.collectionDelete.deletedCollectionId}).`);
        }
      } catch (e) {
        console.error(`  Network or unexpected error deleting collection '${collectionFromLoader.title}' (ID: ${collectionFromLoader.id}):`, e);
        errors.push({ row: 'N/A', message: `Unexpected error deleting collection '${collectionFromLoader.title}': ${e.message}` });
      }
    }
  }


  let summaryMessage = `Import process completed.`;
  let isSuccess = errors.length === 0;

  if (isSuccess) {
    summaryMessage += ` All ${processedRowsCount} rows processed. ${createdCollectionsCount} collections created, ${updatedCollectionsCount} updated, and ${deletedCollectionsCount} deleted. ${updatedMetafieldsCount} metafields set successfully.`;
  } else {
    summaryMessage += ` ${createdCollectionsCount} collections created, ${updatedCollectionsCount} updated, and ${deletedCollectionsCount} deleted. ${updatedMetafieldsCount} metafields set. However, ${errors.length} row(s) had errors.`;
  }

  return json({
    success: isSuccess,
    message: summaryMessage,
    errors,
    processedRowsCount,
    updatedCollectionsCount,
    createdCollectionsCount,
    updatedMetafieldsCount,
    deletedCollectionsCount,
    importedFileName: file.name,
  }, { status: isSuccess ? 200 : 400 });
};


export default function Collections() {
  const { collections, error: loaderError, metafieldDefinitions } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

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

  // Handle action data from import
  useEffect(() => {
    if (fetcher.state === "idle" && actionData) {
      if (actionData.success) {
        setToastContent(actionData.message || "Import completed successfully.");
        setToastError(false);
        setToastActive(true);
        setFileName(""); // Clear file name on success
        setImportErrors([]); // Clear any previous errors

        // Revalidate loader data to show updated collections
        revalidator.revalidate();
      } else {
        setToastContent(actionData.message || "Import failed with errors.");
        setToastError(true);
        setToastActive(true);
        if (actionData.errors) {
          setImportErrors(actionData.errors);
        }
      }
    }
    // Handle toast for submitting state
    if (fetcher.state === "submitting" && fileName) {
      setToastContent(`Importing "${fileName}"... Please wait, this may take a moment.`);
      setToastError(false);
      setToastActive(true);
      setImportErrors([]);
    }
  }, [fetcher.state, actionData, fileName, revalidator]);

  const toggleToastActive = useCallback(() => setToastActive((active) => !active), []);

  const handleDownload = useCallback(async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Collections");

    const uniqueMetafields = new Map();
    collections.forEach(col => {
      col.metafields.nodes.forEach(mf => {
        if (!uniqueMetafields.has(mf.key)) {
          // Store namespace for export to ensure it's re-used on import
          uniqueMetafields.set(mf.key, { key: mf.key, type: mf.type, namespace: mf.namespace });
        }
      });
    });

    // Patterns for smart collection rule headers (to filter out from generic metafields)
    const ruleKeyPatternDash = /^Rule \d+ - (Column|Relation|Condition)$/;
    const ruleKeyPatternColon = /^Rule \d+: (Column|Condition|Relation)$/; // For metafields that might be named like rules

    const metafieldKeysAndTypes = Array.from(uniqueMetafields.values())
        .filter(mt => !ruleKeyPatternDash.test(mt.key) && !ruleKeyPatternColon.test(mt.key)) // Exclude rule-like keys from metafields
        .sort((a, b) => a.key.localeCompare(b.key));

    const metafieldHeaders = metafieldKeysAndTypes.map(mt => mt.key);

    // Determine max number of rules for any smart collection
    let maxRules = 0;
    collections.forEach(col => {
      // Use ruleSet?.rules directly, as exportedRules is just a convenient alias
      if (col.type === "Smart" && col.ruleSet?.rules?.length > maxRules) {
        maxRules = col.ruleSet.rules.length;
      }
    });

    const ruleHeaders = [];
    for (let i = 1; i <= maxRules; i++) {
      ruleHeaders.push(`Rule ${i} - Column`, `Rule ${i} - Relation`, `Rule ${i} - Condition`);
    }

    const headers = [
      "Collection ID",
      "Title",
      "Description",
      "Sort Order",
      "Template Suffix",
      "Collection Type", // Manual or Smart
      "Smart Collection: Applied Disjunctively", // This header will contain "Any" or "All"
      ...ruleHeaders, // Dynamic rule headers
      ...metafieldHeaders, // Now filtered to exclude rule-like keys
    ];
    worksheet.addRow(headers);

    // Create a map from GID to handle for efficient lookup during export
    const gidToHandleMap = new Map();
    collections.forEach(col => {
      gidToHandleMap.set(col.id, col.handle);
    });

    collections.forEach(col => {
      const metafieldMap = {};
      col.metafields.nodes.forEach(mf => {
        // When exporting, prioritize handle for reference types if available, otherwise GID.
        if (mf.type === 'collection_reference') {
          metafieldMap[mf.key] = gidToHandleMap.get(mf.value) || mf.value || "";
        } else if (mf.type === 'list.collection_reference' && mf.value) {
          try {
              const gids = JSON.parse(mf.value);
              if (Array.isArray(gids)) {
                  const handles = gids.map(gid => {
                      return gidToHandleMap.get(gid) || gid; // Prioritize handle, fallback to GID
                  }).filter(Boolean); // Remove any null/undefined
                  metafieldMap[mf.key] = JSON.stringify(handles); // Export as JSON array of handles
              } else {
                  metafieldMap[mf.key] = mf.value; // Fallback to raw value if not an array
              }
          } catch (e) {
              metafieldMap[mf.key] = mf.value; // Fallback to raw value if invalid JSON
          }
        } else if (mf.type.endsWith('_reference') || mf.type.startsWith('list.')) {
          metafieldMap[mf.key] = mf.value || ""; // Export the raw value (GID or JSON array of GIDs)
        } else {
          metafieldMap[mf.key] = mf.displayValue || mf.value || "";
        }
      });

      const ruleData = [];
      // Ensure we use the actual rules from ruleSet, not just exportedRules for consistency
      const currentRules = col.ruleSet?.rules || [];
      currentRules.forEach(rule => {
        ruleData.push(rule.column, rule.relation, rule.condition);
      });
      // Pad with empty strings if fewer rules than maxRules
      while (ruleData.length < maxRules * 3) {
        ruleData.push("", "", "");
      }

      // Convert boolean to "Any" or "All" for export (as requested)
      const appliedDisjunctivelyDisplay = col.type === "Smart"
        ? (col.ruleSet?.appliedDisjunctively ? "Any" : "All")
        : "";

      const rowData = [
        col.id,
        col.title,
        col.descriptionHtml,
        col.sortOrder || "",
        col.templateSuffix || "",
        col.type,
        appliedDisjunctivelyDisplay,
        ...ruleData,
        ...metafieldHeaders.map(key => metafieldMap[key] || ""), // Map based on filtered headers
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
      // Pass the known metafield definitions and ALL existing collections from the loader to the action
      formData.append("collectionsData", JSON.stringify({ collections, metafieldDefinitions }));

      setFileName(selectedFile.name);
      setImportErrors([]); // Clear errors when a new file is dropped
      fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  }, [fetcher, collections, metafieldDefinitions]);

  // This is where `rows` are constructed for the DataTable shown in the UI.
  // This already provides a summary and avoids showing individual rule columns twice.
  const rows = collections.map((collection) => {
    // Generate a summary for Smart Logic column
    const smartLogicSummary = collection.type === "Smart"
      ? (collection.ruleSet?.appliedDisjunctively ? "Match any conditions" : "Match all conditions") +
        (collection.ruleSet?.rules?.length > 0
          ? ` (${collection.ruleSet.rules.length} rule${collection.ruleSet.rules.length > 1 ? 's' : ''})`
          : " (No rules defined)")
      : "N/A";

    return [
      collection.title,
      collection.handle,
      collection.type,
      smartLogicSummary,
      collection.metafields.nodes.length,
      new Date(collection.updatedAt).toLocaleString(),
    ];
  });

  return (
    <Page>
      <TitleBar title="Collections Export/Import" />
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <LegacyStack spacing="tight" vertical>
              <Text variant="headingMd" as="h2">Export Collections to Excel</Text>
              <Text variant="bodyMd" as="p">Download all your Shopify collections, including their core fields, smart collection rules, and custom metafields, into an Excel file. This file can then be updated and re-imported.</Text>
              <Button onClick={handleDownload} primary disabled={navigation.state !== "idle" || collections.length === 0}>
                {navigation.state !== "idle" ? <Spinner size="small" /> : `Export Collections (${collections.length} total)`}
              </Button>
            </LegacyStack>
          </Card>

          <Card sectioned title="Import Updated Excel File">
            <LegacyStack spacing="tight" vertical>
              <Text variant="bodyMd" as="p">
                Upload an Excel file (preferably one exported from this app) to update existing collections and their metafields.
                <br />
                <List type="bullet">
                  <List.Item>
                    **Collection ID (Column A):** Leave empty for new collections, use existing GID for updates. **Crucial:** Ensure this is the correct Shopify GID for existing collections.
                  </List.Item>
                  <List.Item>
                    **Collection Type:** Enter "Manual" or "Smart".
                  </List.Item>
                  <List.Item>
                    **Smart Collection: Applied Disjunctively:** Enter "Any" (for product must match any condition) or "All" (for product must match all conditions).
                  </List.Item>
                  <List.Item>
                    **Smart Collection Rules:** For "Smart" collections, use `Rule X - Column`, `Rule X - Relation`, `Rule X - Condition` columns to define each rule. Each rule requires all three parts.
                  </List.Item>
                  <List.Item>
                    **Metafields:** Custom metafields start after the standard and rule columns. The header should be the metafield's `key`.
                  </List.Item>
                  <List.Item>
                    **Reference Types (`collection_reference`, `list.collection_reference`, etc.):** For single references, you can use either the raw Shopify GID or the collection handle. For list types, a comma-separated list of handles or a valid JSON array string of GIDs (e.g., `["gid://...","gid://..."]`) or handles (e.g., `["handle1","handle2"]`).
                  </List.Item>
                </List>
              </Text>
              <DropZone allowMultiple={false} onDrop={handleDrop} disabled={fetcher.state !== "idle"} accept=".xlsx">
                {fileName ? <Text alignment="center">Selected file: {fileName}</Text> : <DropZone.FileUpload actionHint="Accepts .xlsx files only" />}
              </DropZone>
              {fetcher.state !== "idle" && <Text alignment="center" variant="bodyMd"><Spinner size="small" /> Processing import... This may take a moment.</Text>}
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
                columnContentTypes={["text", "text", "text", "text", "numeric", "text"]}
                headings={["Title", "Handle", "Type", "Smart Logic", "Metafields Count", "Updated At"]}
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