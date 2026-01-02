
import React, { createContext, useContext, useState, ReactNode, useEffect, useRef } from 'react';
import { User, UserRole, FacebookPage, Conversation, Message, ConversationStatus, ApprovedLink, ApprovedMedia } from '../types';
import { MASTER_ADMIN, MOCK_USERS } from '../constants';
import { apiService } from '../services/apiService';
import { fetchPageConversations, verifyPageAccessToken } from '../services/facebookService';

interface SystemLog {
  id: string;
  timestamp: string;
  type: 'info' | 'error' | 'success';
  message: string;
  details?: string;
}

interface CollectionStat {
  name: string;
  count: number;
  lastWrite?: string;
}

interface AppContextType {
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  pages: FacebookPage[];
  updatePage: (id: string, updates: Partial<FacebookPage>) => Promise<void>;
  addPage: (page: FacebookPage) => Promise<void>;
  removePage: (id: string) => Promise<void>;
  conversations: Conversation[];
  updateConversation: (id: string, updates: Partial<Conversation>) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  messages: Message[];
  addMessage: (msg: Message) => Promise<void>;
  bulkAddMessages: (msgs: Message[], silent?: boolean) => Promise<void>;
  agents: User[];
  addAgent: (agent: User) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  updateUser: (id: string, updates: Partial<User>) => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  syncMetaConversations: (limit?: number) => Promise<void>;
  syncFullHistory: () => Promise<void>;
  verifyPageConnection: (pageId: string) => Promise<boolean>;
  approvedLinks: ApprovedLink[];
  addApprovedLink: (link: ApprovedLink) => Promise<void>;
  removeApprovedLink: (id: string) => Promise<void>;
  approvedMedia: ApprovedMedia[];
  addApprovedMedia: (media: ApprovedMedia) => Promise<void>;
  removeApprovedMedia: (id: string) => Promise<void>;
  dbStatus: 'connected' | 'syncing' | 'error' | 'initializing' | 'uninitialized';
  dbName: string;
  dbError: string | null;
  dbLogs: SystemLog[];
  dbCollections: CollectionStat[];
  lastSyncTime: string | null;
  isPolling: boolean;
  refreshMetadata: () => Promise<void>;
  dashboardStats: any;
  // Added methods required for system maintenance and settings
  forceWriteTest: () => Promise<boolean>;
  clearLocalChats: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);
const USER_SESSION_KEY = 'messengerflow_supabase_session_v1';

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [dbStatus, setDbStatus] = useState<'connected' | 'syncing' | 'error' | 'initializing' | 'uninitialized'>('initializing');
  const [dbName, setDbName] = useState("Supabase Cloud");
  const [dbError, setDbError] = useState<string | null>(null);
  const [dbLogs, setDbLogs] = useState<SystemLog[]>([]);
  const [dbCollections, setDbCollections] = useState<CollectionStat[]>([]);
  
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<User[]>(MOCK_USERS);
  const [messages, setMessages] = useState<Message[]>([]);
  const [approvedLinks, setApprovedLinks] = useState<ApprovedLink[]>([]);
  const [approvedMedia, setApprovedMedia] = useState<ApprovedMedia[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  const pollIntervalRef = useRef<number | null>(null);

  const addLog = (type: 'info' | 'error' | 'success', message: string, details?: string) => {
    const newLog: SystemLog = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
      details
    };
    setDbLogs(prev => [newLog, ...prev].slice(0, 50));
  };

  const refreshMetadata = async () => {
    try {
      const collections = await apiService.getDbMetadata();
      setDbCollections(collections);
    } catch (e: any) {
      addLog('error', 'Metadata Refresh Failed', e.message);
    }
  };

  const syncMetaConversations = async (limit: number = 20) => {
    if (pages.length === 0) return;
    setIsPolling(true);
    
    try {
      const syncPromises = pages.map(async (page) => {
        if (!page.accessToken) return [];
        try {
          const meta = await fetchPageConversations(page.id, page.accessToken, limit, true);
          // Parallelize writes to Supabase
          await Promise.all(meta.map(c => apiService.put('conversations', c)));
          return meta;
        } catch (e) {
          console.error(`Sync failed for page ${page.id}`, e);
          return [];
        }
      });

      await Promise.all(syncPromises);
      
      // Refresh local state from Cloud
      const all = await apiService.getAll<Conversation>('conversations');
      setConversations(all);
      setLastSyncTime(new Date().toLocaleTimeString());
      addLog('success', 'Background Sync Complete', `Updated ${all.length} conversations`);
    } catch (err: any) {
      addLog('error', 'Auto-Sync Error', err.message);
    } finally {
      setIsPolling(false);
    }
  };

  const loadDataFromCloud = async () => {
    setDbStatus('syncing');
    setDbError(null);
    addLog('info', 'Connecting to Workspace...');
    
    try {
      const [agentsData, pagesData, convsData, msgsData, linksData, mediaData] = await Promise.all([
        apiService.getAll<User>('agents'),
        apiService.getAll<FacebookPage>('pages'),
        apiService.getAll<Conversation>('conversations'),
        apiService.getAll<Message>('messages'),
        apiService.getAll<ApprovedLink>('links'),
        apiService.getAll<ApprovedMedia>('media')
      ]);

      setAgents(agentsData.length > 0 ? agentsData : MOCK_USERS);
      setPages(pagesData);
      setConversations(convsData);
      setMessages(msgsData);
      setApprovedLinks(linksData);
      setApprovedMedia(mediaData);
      
      setDbStatus('connected');
      addLog('success', 'Cloud Connection Active');

      const session = localStorage.getItem(USER_SESSION_KEY);
      if (session) setCurrentUser(JSON.parse(session));
    } catch (err: any) {
      setDbStatus('error');
      setDbError(err.message);
      addLog('error', 'Cloud Load Error', err.message);
    }
  };

  // Automated Polling Engine
  useEffect(() => {
    if (dbStatus === 'connected' && currentUser && pages.length > 0) {
      // Immediate sync
      syncMetaConversations(10);

      // Setup 15s interval for background updates
      pollIntervalRef.current = window.setInterval(() => {
        syncMetaConversations(10);
      }, 15000);

      return () => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      };
    }
  }, [dbStatus, currentUser, pages.length]);

  useEffect(() => {
    loadDataFromCloud();
  }, []);

  // Added missing implementation for system settings methods
  const forceWriteTest = async (): Promise<boolean> => {
    try {
      addLog('info', 'Executing manual handshake test...');
      const result = await apiService.manualWriteToTest();
      if (result) {
        addLog('success', 'Manual Handshake Verified');
      }
      return result;
    } catch (e: any) {
      addLog('error', 'Handshake Test Failed', e.message);
      return false;
    }
  };

  const clearLocalChats = async () => {
    localStorage.removeItem(USER_SESSION_KEY);
    addLog('info', 'Local cache purged. Resetting session...');
    window.location.reload();
  };

  const value: AppContextType = {
    currentUser, setCurrentUser,
    pages,
    addPage: async (p) => { await apiService.put('pages', p); setPages(prev => [...prev, p]); },
    removePage: async (id) => { await apiService.delete('pages', id); setPages(prev => prev.filter(p => p.id !== id)); },
    updatePage: async (id, u) => {
      const updated = pages.map(p => p.id === id ? { ...p, ...u } : p);
      setPages(updated);
      const page = updated.find(p => p.id === id);
      if (page) await apiService.put('pages', page);
    },
    conversations: [...conversations].sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()),
    updateConversation: async (id, u) => {
      const updated = conversations.map(c => c.id === id ? { ...c, ...u } : c);
      setConversations(updated);
      const conv = updated.find(c => c.id === id);
      if (conv) await apiService.put('conversations', conv);
    },
    deleteConversation: async (id) => {
      await apiService.delete('conversations', id);
      setConversations(prev => prev.filter(c => c.id !== id));
    },
    messages,
    addMessage: async (m) => { await apiService.put('messages', m); setMessages(p => [...p, m]); },
    bulkAddMessages: async (msgs) => {
      await Promise.all(msgs.map(m => apiService.put('messages', m)));
      setMessages(prev => [...prev, ...msgs]);
    },
    agents,
    addAgent: async (a) => { await apiService.put('agents', a); setAgents(prev => [...prev, a]); },
    removeAgent: async (id) => { await apiService.delete('agents', id); setAgents(p => p.filter(a => a.id !== id)); },
    updateUser: async (id, u) => {
      const updated = agents.map(a => a.id === id ? { ...a, ...u } : a);
      setAgents(updated);
      const agent = updated.find(a => a.id === id);
      if (agent) await apiService.put('agents', agent);
    },
    login: async (e, p) => {
      if (e === MASTER_ADMIN.email && p === MASTER_ADMIN.password) {
        setCurrentUser(MASTER_ADMIN);
        localStorage.setItem(USER_SESSION_KEY, JSON.stringify(MASTER_ADMIN));
        return true;
      }
      const remoteUser = agents.find(u => u.email === e && u.password === p);
      if (remoteUser) {
        setCurrentUser(remoteUser);
        localStorage.setItem(USER_SESSION_KEY, JSON.stringify(remoteUser));
        return true;
      }
      return false;
    },
    logout: async () => { localStorage.removeItem(USER_SESSION_KEY); setCurrentUser(null); },
    syncMetaConversations,
    syncFullHistory: async () => {
      addLog('info', 'Deep Sync Initiated...');
      await syncMetaConversations(100); 
    },
    verifyPageConnection: async (id) => {
      const page = pages.find(p => p.id === id);
      return page ? await verifyPageAccessToken(id, page.accessToken) : false;
    },
    approvedLinks,
    addApprovedLink: async (l) => { await apiService.put('links', l); setApprovedLinks(p => [...p, l]); },
    removeApprovedLink: async (id) => { await apiService.delete('links', id); setApprovedLinks(p => p.filter(l => l.id !== id)); },
    approvedMedia,
    addApprovedMedia: async (m) => { await apiService.put('media', m); setApprovedMedia(p => [...p, m]); },
    removeApprovedMedia: async (id) => { await apiService.delete('media', id); setApprovedMedia(p => p.filter(m => m.id !== id)); },
    dbStatus,
    dbName,
    dbError,
    dbLogs,
    dbCollections,
    lastSyncTime,
    isPolling,
    refreshMetadata,
    dashboardStats: {
      openChats: conversations.filter(c => c.status === ConversationStatus.OPEN).length,
      avgResponseTime: "0m 45s",
      resolvedToday: conversations.filter(c => c.status === ConversationStatus.RESOLVED).length,
      csat: "99%",
      chartData: [{ name: 'Mon', conversations: 14 }, { name: 'Tue', conversations: 28 }, { name: 'Wed', conversations: 31 }, { name: 'Thu', conversations: 19 }, { name: 'Fri', conversations: 44 }]
    },
    // Added value object mappings for new methods
    forceWriteTest,
    clearLocalChats
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within an AppProvider');
  return context;
};
