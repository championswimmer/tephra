// One entry per cloud deploy page (src/pages/deploy/[cloud].astro) and per tile in the landing
// page's Getting started section. Detailed, nerdy instructions live in docs/deploy/*.md.

export interface DiagramNode {
  icon: string;
  title: string;
  sub: string;
}

export interface CloudStep {
  title: string;
  /** Short HTML; keep it to one or two sentences. */
  body?: string;
  cmd?: string;
}

export interface Cloud {
  slug: string;
  name: string;
  icon: string;
  /** Brand color, used only for the cloud's own logo. */
  brand: string;
  time: string;
  badge?: string;
  blurb: string;
  needs: string[];
  launch?: { href: string; label: string };
  steps: CloudStep[];
  doc: string;
  diagram: {
    region: string;
    gateway: DiagramNode;
    compute: { icon: string; title: string };
    proxy?: DiagramNode;
    storage: DiagramNode;
    secrets: DiagramNode;
    extra?: DiagramNode & { link: string };
  };
}

const repo = 'https://github.com/championswimmer/tephra';
const clone = `git clone ${repo} && cd tephra`;

const caddy: DiagramNode = { icon: 'lucide:lock-keyhole', title: 'Caddy', sub: 'automatic HTTPS' };

const pointDomain: CloudStep = {
  title: 'Point your domain at it',
  body: 'The script prints an IP address. At your domain provider, add an <code>A</code> record for your domain pointing to that IP.',
};

export const clouds: Cloud[] = [
  {
    slug: 'railway',
    name: 'Railway',
    icon: 'simple-icons:railway',
    brand: 'currentColor',
    time: '~5 min',
    badge: 'Easiest',
    blurb: 'Three commands. HTTPS and a web address come included.',
    needs: ['A Railway account', 'Node.js on your computer'],
    steps: [
      {
        title: 'Install the Railway CLI and sign in',
        cmd: 'npm i -g @railway/cli && railway login',
      },
      {
        title: 'Grab Tephra and make a project',
        cmd: `${clone} && railway init`,
      },
      {
        title: 'Launch it',
        body: 'This sets up the server, its disk and its secrets in one go.',
        cmd: 'npm run deploy:railway',
      },
      {
        title: 'Copy your setup token',
        body: "You'll paste it once, when you create your login. Your server's web address is on the service page in Railway.",
        cmd: 'railway variable list --service tephra --kv | grep BOOTSTRAP',
      },
    ],
    doc: `${repo}/blob/main/docs/deploy/RAILWAY.md`,
    diagram: {
      region: 'Railway project',
      gateway: { icon: 'lucide:shield-check', title: 'Railway edge', sub: 'HTTPS + domain' },
      compute: { icon: 'lucide:box', title: 'Service · 1 replica' },
      storage: { icon: 'lucide:hard-drive', title: 'Volume', sub: '/data · your notes' },
      secrets: { icon: 'lucide:key-round', title: 'Variables', sub: 'session + setup token' },
    },
  },
  {
    slug: 'aws',
    name: 'AWS',
    icon: 'simple-icons:amazonwebservices',
    brand: '#ff9900',
    time: '~10 min',
    blurb: 'One small EC2 server with its own disk.',
    needs: ['An AWS account, with the aws CLI signed in', 'A domain you can add DNS records to'],
    steps: [
      { title: 'Grab Tephra', cmd: clone },
      {
        title: 'Launch it',
        body: 'Swap in your own domain. The server, disk, IP and HTTPS are all set up for you.',
        cmd: 'DOMAIN=notes.example.com scripts/deploy/aws.sh',
      },
      {
        ...pointDomain,
        body: `${pointDomain.body} On Route 53? Add <code>HOSTED_ZONE_ID=…</code> to the command above and this is done for you.`,
      },
      {
        title: 'Copy your setup token',
        body: "Give the server about 5 minutes to warm up. You'll paste the token once, when you create your login.",
        cmd: 'grep BOOTSTRAP ~/.tephra-aws-notes.example.com.env',
      },
    ],
    doc: `${repo}/blob/main/docs/deploy/AWS.md`,
    diagram: {
      region: 'AWS account',
      gateway: { icon: 'lucide:shield-check', title: 'Elastic IP', sub: 'firewall 80 / 443' },
      compute: { icon: 'lucide:server', title: 'EC2 instance' },
      proxy: caddy,
      storage: { icon: 'lucide:hard-drive', title: 'EBS volume', sub: '/data · your notes' },
      secrets: { icon: 'lucide:key-round', title: '.env file', sub: 'locked to root' },
    },
  },
  {
    slug: 'gcp',
    name: 'Google Cloud',
    icon: 'simple-icons:googlecloud',
    brand: '#4285f4',
    time: '~10 min',
    blurb: 'One small VM, launched right from your browser.',
    needs: ['A Google Cloud project with billing on', 'A domain you can add DNS records to'],
    launch: {
      href: 'https://shell.cloud.google.com/cloudshell/open?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Fchampionswimmer%2Ftephra.git&cloudshell_workspace=.&cloudshell_open_in_editor=docs%2Fdeploy%2FGCP.md',
      label: 'Open in Cloud Shell',
    },
    steps: [
      {
        title: 'Open Cloud Shell',
        body: "Use the button above. You're already signed in and Tephra is already downloaded.",
      },
      {
        title: 'Launch it',
        body: 'Swap in your project ID and domain.',
        cmd: 'PROJECT=my-project ZONE=us-central1-a DOMAIN=notes.example.com scripts/deploy/gcp.sh',
      },
      pointDomain,
      {
        title: 'Copy your setup token',
        body: "Give the server about 5 minutes to warm up. You'll paste the token once, when you create your login.",
        cmd: 'gcloud secrets versions access latest --secret=tephra-bootstrap-token',
      },
    ],
    doc: `${repo}/blob/main/docs/deploy/GCP.md`,
    diagram: {
      region: 'Google Cloud project',
      gateway: { icon: 'lucide:shield-check', title: 'Static IP', sub: 'firewall 80 / 443' },
      compute: { icon: 'lucide:server', title: 'Compute Engine VM' },
      proxy: caddy,
      storage: { icon: 'lucide:hard-drive', title: 'Persistent Disk', sub: '/data · your notes' },
      secrets: { icon: 'lucide:key-round', title: 'Secret Manager', sub: 'session + setup token' },
      extra: { icon: 'lucide:package', title: 'Artifact Registry', sub: 'Tephra image', link: 'pulls' },
    },
  },
  {
    slug: 'digitalocean',
    name: 'DigitalOcean',
    icon: 'simple-icons:digitalocean',
    brand: '#0080ff',
    time: '~10 min',
    blurb: 'One Droplet with a Volume attached. Simple and cheap.',
    needs: [
      'The doctl CLI, signed in with <code>doctl auth init</code>',
      'An SSH key added to your DigitalOcean account',
      'A domain you can add DNS records to',
    ],
    steps: [
      { title: 'Grab Tephra', cmd: clone },
      {
        title: 'Launch it',
        body: 'Swap in your own domain. The Droplet, Volume, IP and HTTPS are all set up for you.',
        cmd: 'DOMAIN=notes.example.com ./scripts/deploy/do.sh',
      },
      {
        ...pointDomain,
        body: `${pointDomain.body} Domain already on DigitalOcean? Add <code>DNS_ZONE=example.com</code> to the command above and this is done for you.`,
      },
      {
        title: 'Copy your setup token',
        body: 'Give the server about 5 minutes to warm up. The script prints this exact command with your IP filled in.',
        cmd: 'ssh root@YOUR_IP grep BOOTSTRAP /opt/tephra/tephra.env',
      },
    ],
    doc: `${repo}/blob/main/docs/deploy/DO.md`,
    diagram: {
      region: 'DigitalOcean',
      gateway: { icon: 'lucide:shield-check', title: 'Reserved IP', sub: 'firewall 80 / 443' },
      compute: { icon: 'lucide:server', title: 'Droplet' },
      proxy: caddy,
      storage: { icon: 'lucide:hard-drive', title: 'Volume', sub: '/data · your notes' },
      secrets: { icon: 'lucide:key-round', title: 'env file', sub: 'locked to root' },
    },
  },
];
