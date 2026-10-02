import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => ({ heading: params.conversation.includes(':') ? 'Conversation' : `#${params.conversation}` });
