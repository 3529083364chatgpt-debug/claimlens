import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClaimLens · 投研论断核验工作台',
  description: '对投研内容做逐条事实核查与合规治理：论断拆解 → 真实数据源取证 → 确定性比对 → 可回溯证据',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-zinc-50 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
