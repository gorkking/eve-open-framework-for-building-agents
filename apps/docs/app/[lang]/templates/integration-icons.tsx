import { BracesIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  githubLogo,
  linearLogo,
  notionLogo,
  nuxtLogo,
  sendblueLogo,
  sentryLogo,
  slackLogo,
  webLogo,
} from "@/lib/integrations/logos";
import type { TemplateIntegration } from "@/lib/templates/data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  GitHub: githubLogo,
  "HTTP API": BracesIcon,
  Linear: linearLogo,
  Notion: notionLogo,
  Nuxt: nuxtLogo,
  Sendblue: sendblueLogo,
  Sentry: sentryLogo,
  Slack: slackLogo,
  "Web chat": webLogo,
};
