import { createTrustPageMetadata, TrustPage } from "@/components/geistdocs/trust-page";

export const metadata = createTrustPageMetadata("contact");

const ContactPage = () => <TrustPage slug="contact" />;

export default ContactPage;
