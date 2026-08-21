import { createTrustPageMetadata, TrustPage } from "@/components/geistdocs/trust-page";

export const metadata = createTrustPageMetadata("about");

const AboutPage = () => <TrustPage slug="about" />;

export default AboutPage;
