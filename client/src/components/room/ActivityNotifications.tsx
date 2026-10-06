import React from 'react';
import { UserPlus, UserMinus, Info } from 'lucide-react';

export interface ActivityNotification {
  id: string;
  type: 'join' | 'leave' | 'info';
  message: string;
  timestamp: number;
}

interface ActivityNotificationsProps {
  notifications: ActivityNotification[];
}

export const ActivityNotifications: React.FC<ActivityNotificationsProps> = ({ notifications }) => {
  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm pointer-events-none">
      {notifications.map((n) => (
        <div
          key={n.id}
          className="p-3 rounded-xl bg-slate-900 border border-slate-700 shadow-xl flex items-center gap-2.5 text-xs text-slate-200 animate-slideUp backdrop-blur-md"
        >
          {n.type === 'join' && <UserPlus className="w-4 h-4 text-emerald-400 shrink-0" />}
          {n.type === 'leave' && <UserMinus className="w-4 h-4 text-rose-400 shrink-0" />}
          {n.type === 'info' && <Info className="w-4 h-4 text-indigo-400 shrink-0" />}
          <span className="flex-1 font-medium">{n.message}</span>
        </div>
      ))}
    </div>
  );
};
