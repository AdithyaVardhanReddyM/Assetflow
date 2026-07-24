import { AssetLibrary } from "@/components/studio/asset-library";

export const metadata = { title: "Library · Asset Flow" };

/**
 * The library is client-fetched: the list needs the caller's auth headers and
 * every row carries a short-lived presigned preview URL, so there is nothing
 * for the server to render ahead of time that would still be valid on arrival.
 */
export default function AssetsPage() {
  return <AssetLibrary />;
}
