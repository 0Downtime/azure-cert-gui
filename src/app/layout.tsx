import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Azure Cert GUI",
  description: "Internal Azure and Entra credential expiration worklist"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
try {
  var theme = window.localStorage.getItem("azure-cert-gui-theme") || window.localStorage.getItem("gstack-theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
} catch (_) {}
`
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
