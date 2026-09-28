import "./globals.css";

export const metadata = {
  title: "Sosyal İtibar",
  description: "Facebook ve Instagram yorum izleme ve LLM destekli itibar analizi",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="tr"><body>{children}</body></html>;
}
