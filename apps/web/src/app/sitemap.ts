import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl()
  return [
    { path: '/', priority: 1 },
    { path: '/download', priority: 0.9 },
    { path: '/pricing', priority: 0.8 },
    { path: '/privacy', priority: 0.3 },
    { path: '/terms', priority: 0.3 }
  ].map((entry) => ({
    url: new URL(entry.path, base).toString(),
    changeFrequency: 'weekly',
    priority: entry.priority
  }))
}
