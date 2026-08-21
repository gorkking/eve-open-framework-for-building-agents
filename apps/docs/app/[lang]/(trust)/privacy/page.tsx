import { createTrustPageMetadata, TrustPage } from "@/components/geistdocs/trust-page";

export const metadata = createTrustPageMetadata("privacy");

const PrivacyPage = () => <TrustPage slug="privacy" />;

export default PrivacyPage;
