# Multi-User LAN Architecture Design

## Vision

Enable multiple users in a local network to collaborate on tasks, with each user playing a different role (PM, Developer, Tester, etc.) and contributing their specific expertise to solve complex problems together.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        LAN Network                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│   │ User A  │    │ User B  │    │ User C  │    │ User D  │
│   │ (PM)    │◄──►│ (Dev)   │◄──►│ (QA)    │◄──►│ (Dev)   │
│   │ 192.168 │    │ 192.168 │    │ 192.168 │    │ 192.168 │
│   │   .1.10 │    │   .1.20 │    │   .1.30 │    │   .1.40 │
│   └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘
│        │              │              │              │
│        └──────────────┼──────────────┼──────────────┘
│                       ▼
│              ┌─────────────────┐
│              │   Message Hub    │
│              │   (P2P/WebSocket)│
│              └─────────────────┘
│                       │
│              ┌────────┴────────┐
│              │  Task Broker    │
│              │  (Shared Tasks) │
│              └─────────────────┘
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Message Hub
- P2P WebSocket connections between users
- Message routing and delivery
- Online status tracking
- Direct messaging
- Group messaging

### 2. Task Broker
- Shared task pool
- Task assignment and claiming
- Progress tracking
- Result aggregation

### 3. Role Manager
- User role registration
- Capability matching
- Task routing based on roles

## Data Models

### User
```typescript
interface NetworkUser {
  id: string;
  name: string;
  role: 'pm' | 'developer' | 'tester' | 'designer' | 'devops';
  capabilities: string[];
  ipAddress: string;
  port: number;
  status: 'online' | 'offline' | 'busy';
  currentTask?: string;
}
```

### Task
```typescript
interface SharedTask {
  id: string;
  title: string;
  description: string;
  subtasks: SubTask[];
  owner: string;
  participants: string[];
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: number;
  completedAt?: number;
}

interface SubTask {
  id: string;
  description: string;
  assignee?: string;
  status: 'pending' | 'assigned' | 'in_progress' | 'completed';
  result?: string;
}
```

### Message
```typescript
interface NetworkMessage {
  id: string;
  from: string;
  to?: string;
  groupId?: string;
  type: 'direct' | 'group' | 'broadcast' | 'task' | 'result';
  content: string;
  timestamp: number;
}
```

## Communication Protocol

### Discovery
1. User starts -> Broadcast presence announcement
2. Other users respond with their info
3. Direct P2P connection established

### Task Distribution
1. PM creates task with subtasks
2. System matches subtasks to user roles
3. Subtasks assigned automatically or manually
4. Each user works on their subtask
5. Results collected and aggregated

### Example Flow
```
User A (PM): "帮我完成这个项目：后端API、前端界面、测试"
  │
  ├─► Task Created
  │
  ├─► Subtask 1: 后端API ──────────► User B (Backend Dev)
  │       │
  │       └─► User B completes, sends result
  │
  ├─► Subtask 2: 前端界面 ─────────► User D (Frontend Dev)  
  │       │
  │       └─► User D completes, sends result
  │
  ├─► Subtask 3: 测试 ────────────► User C (QA)
  │       │
  │       └─► User C tests, sends report
  │
  └─► PM receives all results, aggregates final output
```

## Future Enhancements

- [ ] WebSocket-based real-time communication
- [ ] Task dependency graph visualization
- [ ] Cross-platform desktop app (Electron/Tauri)
- [ ] File sharing between users
- [ ] Screen sharing for code review
- [ ] Voice chat integration
- [ ] Video call for meetings
- [ ] Shared terminal for pair programming

## Implementation Priority

1. **Phase 1**: Basic messaging (P2P WebSocket)
2. **Phase 2**: Task distribution system
3. **Phase 3**: Role-based routing
4. **Phase 4**: Result aggregation
5. **Phase 5**: UI for multi-user interaction

## CLI Commands (Future)

```bash
/connect <ip>:<port>     # Connect to another user
/disconnect               # Disconnect from network
/team create <name>      # Create a team/group
/team join <team-id>     # Join a team
/team leave              # Leave current team
/assign <user> <task>    # Assign task to user
/status                  # Show network status
/users                   # List online users
/members                 # List team members
```
