import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

export default defineConfig({
  integrations: [
    mermaid({ autoTheme: true }), // must come before starlight
    starlight({
      title: 'MC-AI',
      description:
        'Agentic orchestration built on a Cyclic State Graph architecture.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/wmcmahan/mc-ai' },
      ],
      editLink: {
        baseUrl: 'https://github.com/wmcmahan/mc-ai/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
          ],
        },
        {
          label: 'Core Concepts',
          items: [
            { label: 'How MC-AI Works', slug: 'concepts/overview' },
            { label: 'Graphs & Nodes', slug: 'concepts/graphs-and-nodes' },
            { label: 'Workflow State', slug: 'concepts/workflow-state' },
            { label: 'Agents', slug: 'concepts/agents' },
            { label: 'Reducers', slug: 'concepts/reducers' },
            { label: 'Error Handling', slug: 'concepts/error-handling' },
          ],
        },
        {
          label: 'Workflow Patterns',
          items: [
            { label: 'Supervisor', slug: 'patterns/supervisor' },
            { label: 'Evolution (DGM)', slug: 'patterns/evolution' },
            { label: 'Self-Annealing', slug: 'patterns/self-annealing' },
            { label: 'Swarm', slug: 'patterns/swarm' },
            { label: 'Human-in-the-Loop', slug: 'patterns/human-in-the-loop' },
            { label: 'Map-Reduce', slug: 'patterns/map-reduce' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Your First Workflow', slug: 'guides/first-workflow' },
            { label: 'Custom LLM Providers', slug: 'guides/custom-providers' },
            { label: 'Adding MCP Tools', slug: 'guides/adding-tools' },
            { label: 'Using the Architect', slug: 'guides/architect' },
          ],
        },
        {
          label: 'Observability',
          items: [
            { label: 'Tracing', slug: 'observability/tracing' },
            { label: 'Evaluations', slug: 'observability/evals' },
          ],
        },
        { label: 'Security', slug: 'security' },
        { label: 'Contributing', slug: 'contributing' },
      ],
    }),
  ],
});
