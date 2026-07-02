import { PROVIDERS, type ProviderId } from '@agent-console/shared';

export type ConsoleRouteKind = 'home' | 'project' | 'provider' | 'conversation' | 'settings' | 'login' | 'not-found';

export interface ConsoleRouteSelection {
  kind: ConsoleRouteKind;
  selectedProjectSlug?: string;
  selectedProvider?: ProviderId;
  selectedConversationRef?: string;
  conversationRouteActive: boolean;
  inSettings: boolean;
  isLogin: boolean;
  isConsoleRoute: boolean;
}

export interface ConsoleRouteParams {
  projectSlug?: string;
  provider?: string;
  conversationRef?: string;
}

function decodeRouteParam(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isProviderId(value: string | undefined): value is ProviderId {
  return PROVIDERS.includes(value as ProviderId);
}

export function selectConsoleRoute(kind: ConsoleRouteKind, params: ConsoleRouteParams = {}): ConsoleRouteSelection {
  if (kind === 'login') {
    return {
      kind,
      conversationRouteActive: false,
      inSettings: false,
      isLogin: true,
      isConsoleRoute: false,
    };
  }

  if (kind === 'settings') {
    return {
      kind,
      conversationRouteActive: false,
      inSettings: true,
      isLogin: false,
      isConsoleRoute: false,
    };
  }

  if (kind === 'not-found') {
    return {
      kind,
      conversationRouteActive: false,
      inSettings: false,
      isLogin: false,
      isConsoleRoute: false,
    };
  }

  const selectedProjectSlug = decodeRouteParam(params.projectSlug);
  const selectedProvider = isProviderId(params.provider) ? params.provider : undefined;
  const selectedConversationRef = decodeRouteParam(params.conversationRef);

  if ((kind === 'provider' || kind === 'conversation') && !selectedProvider) {
    return selectConsoleRoute('not-found');
  }

  if (kind === 'conversation' && (!selectedProjectSlug || !selectedProvider || !selectedConversationRef)) {
    return selectConsoleRoute('not-found');
  }

  return {
    kind,
    selectedProjectSlug,
    selectedProvider,
    selectedConversationRef: kind === 'conversation' ? selectedConversationRef : undefined,
    conversationRouteActive: kind === 'conversation',
    inSettings: false,
    isLogin: false,
    isConsoleRoute: true,
  };
}
