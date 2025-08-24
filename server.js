const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const uuid = require('uuid');

// 创建HTTP服务器
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// 存储所有聊天室
const rooms = new Map();
// 存储所有连接的客户端
const clients = new Map();

// 默认房间
const defaultRoom = {
  id: uuid.v4(),
  name: '公共聊天室',
  creatorId: null,
  creatorName: '系统',
  isPrivate: false,
  password: null,
  users: new Set(),
  history: []
};
rooms.set(defaultRoom.id, defaultRoom);

// 服务器端消息显示函数
function displayServerMessage(message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${message}`);
}

// 处理WebSocket连接
wss.on('connection', (ws, req) => {
  const location = url.parse(req.url, true);
  const tempClientId = uuid.v4();
  
  // 存储客户端信息
  const client = {
    id: tempClientId,
    ws,
    name: '匿名用户',
    avatar: 'https://cdn-icons-png.flaticon.com/512/681/681494.png',
    currentRoom: null,
    isVerified: false
  };
  clients.set(tempClientId, client);
  
  displayServerMessage(`新客户端连接: ${tempClientId} (IP: ${req.socket.remoteAddress})`);
  updateOnlineCount();
  
  // 发送初始化数据
  sendInitialData(client);
  
  // 处理消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      displayServerMessage(`收到来自 ${client.name} (${client.id}) 的消息: ${JSON.stringify(data)}`);
      handleMessage(client, data);
    } catch (error) {
      displayServerMessage(`消息解析错误 (客户端: ${client.id}): ${error}`);
      console.error('消息解析错误:', error);
    }
  });
  
  // 处理断开连接
  ws.on('close', () => {
    displayServerMessage(`客户端断开连接: ${client.name} (${client.id})`);
    
    // 从当前房间移除用户
    if (client.currentRoom) {
      const room = rooms.get(client.currentRoom);
      if (room) {
        room.users.delete(client.id);
        
        // 通知其他用户该用户已离开
        broadcastToRoom(room.id, {
          type: 'user-left',
          user: {
            id: client.id,
            name: client.name,
            avatar: client.avatar
          },
          userCount: room.users.size
        });
        
        // 更新房间人数
        broadcastRoomUserCount(room.id);
      }
    }
    
    clients.delete(client.id);
    updateOnlineCount();
  });
});

// 发送初始化数据
function sendInitialData(client) {
  const roomList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    creatorId: room.creatorId,
    creatorName: room.creatorName || '未知',
    isPrivate: room.isPrivate,
    userCount: room.users.size
  }));
  
  client.ws.send(JSON.stringify({
    type: 'init',
    rooms: roomList,
    totalUsers: clients.size
  }));
}

// 处理客户端消息
function handleMessage(client, data) {
  switch (data.type) {
    case 'user':
      // 获取旧ID，用于更新 clients Map 的键
      const oldId = client.id;
      
      // 使用客户端提供的ID作为其固定ID
      if (data.id && data.id.trim() !== '') {
        client.id = data.id.trim();
      }

      // 更新客户端的其他信息
      client.name = data.name;
      client.avatar = data.avatar;
      client.isVerified = true;

      // 如果ID已更新，需要从 Map 中删除旧条目并添加新条目
      if (oldId !== client.id) {
        clients.delete(oldId);
        clients.set(client.id, client);
      }

      displayServerMessage(`用户信息更新: ${client.name} (${client.id})`);
      break;
    
    case 'create-room':
      displayServerMessage(`${client.name} 请求创建房间: ${data.name || '未命名聊天室'}`);
      createRoom(client, data);
      break;
      
    case 'join-room':
      displayServerMessage(`${client.name} ${client.id} 请求加入房间: ${data.roomId}`);
      joinRoom(client, data);
      break;
      
    case 'message':
      displayServerMessage(`${client.name} 发送消息到房间 ${client.currentRoom}: ${data.content}`);
      sendMessage(client, data);
      break;
      
    case 'image':
      displayServerMessage(`${client.name} 发送图片到房间 ${client.currentRoom}`);
      sendImage(client, data);
      break;
      
    case 'delete-room':
      displayServerMessage(`${client.name} 请求删除房间: ${data.roomId}`);
      deleteRoom(client, data);
      break;
      
    case 'rename-room':
      displayServerMessage(`${client.name} 请求重命名房间 ${data.roomId} 为 ${data.newName}`);
      renameRoom(client, data);
      break;
      
    case 'get-online-count':
      displayServerMessage(`${client.name} 请求获取在线人数`);
      updateOnlineCount();
      break;

    default:
      displayServerMessage(`未知消息类型: ${data.type} (来自 ${client.name})`);
      console.warn('未知消息类型:', data.type);
  }
}

// 创建新房间
function createRoom(client, data) {
  if (!client.isVerified) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '请先设置用户ID',
      code: 'unverified-user'
    }));
    return;
  }

  const roomId = uuid.v4();
  const newRoom = {
    id: roomId,
    name: data.name || '未命名聊天室',
    creatorId: client.id,
    creatorName: client.name,
    isPrivate: !!data.password,
    password: data.password || null,
    users: new Set(),
    history: []
  };
  
  rooms.set(roomId, newRoom);
  displayServerMessage(`新房间创建成功: ${newRoom.name} (${roomId}) 由 ${client.name} 创建`);
  
  // 通知所有客户端更新房间列表
  broadcastRoomList();
  
  // 自动加入新创建的房间
  joinRoom(client, {
    roomId: roomId,
    password: data.password
  });
}

// 删除房间
function deleteRoom(client, data) {
  const room = rooms.get(data.roomId);
  
  if (!room) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '房间不存在',
      code: 'room-not-found'
    }));
    return;
  }
  
  if (room.creatorId !== data.creatorId || room.creatorId !== client.id) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '只有房间创建者可删除房间',
      code: 'not-creator'
    }));
    return;
  }
  
  if (room.id === defaultRoom.id) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '不能删除默认房间',
      code: 'cannot-delete-default'
    }));
    return;
  }
  
  displayServerMessage(`删除房间: ${room.name} (${room.id}) 由 ${client.name} 发起`);
  
  // 通知所有用户房间将被删除
  broadcastToRoom(room.id, {
    type: 'room-deleting',
    roomId: room.id,
    roomName: room.name
  });
  
  // 强制移除所有用户
  const usersToRemove = Array.from(room.users);
  usersToRemove.forEach(userId => {
    const userClient = clients.get(userId);
    if (userClient) {
      userClient.currentRoom = null;
      userClient.ws.send(JSON.stringify({
        type: 'force-leave-room',
        roomId: room.id,
        reason: '房间已被删除'
      }));
    }
  });
  
  // 从房间列表移除
  rooms.delete(room.id);
  
  // 广播更新后的房间列表
  broadcastRoomList();
  
  // 发送删除确认
  client.ws.send(JSON.stringify({
    type: 'room-deleted',
    roomId: room.id,
    roomName: room.name,
    rooms: Array.from(rooms.values()).map(r => ({
      id: r.id,
      name: r.name,
      creatorId: r.creatorId,
      isPrivate: r.isPrivate,
      userCount: r.users.size
    }))
  }));
}

// 重命名房间
function renameRoom(client, data) {
  const room = rooms.get(data.roomId);
  
  if (!room) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '房间不存在',
      code: 'room-not-found'
    }));
    return;
  }
  
  if (room.creatorId !== data.creatorId || room.creatorId !== client.id) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '只有房间创建者可重命名房间',
      code: 'not-creator'
    }));
    return;
  }
  
  if (!data.newName || data.newName.trim().length === 0) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '房间名称不能为空',
      code: 'empty-name'
    }));
    return;
  }
  
  const oldName = room.name;
  room.name = data.newName.trim();
  room.creatorName = client.name;
  
  displayServerMessage(`房间重命名: ${oldName} -> ${room.name} (${room.id}) 由 ${client.name} 发起`);
  
  // 广播房间重命名通知
  broadcastToRoom(room.id, {
    type: 'room-renamed',
    roomId: room.id,
    oldName: oldName,
    newName: room.name,
    creatorId: room.creatorId,
    creatorName: room.creatorName
  });
  
  // 更新房间列表
  broadcastRoomList();
  
  // 发送重命名确认
  client.ws.send(JSON.stringify({
    type: 'room-renamed',
    roomId: room.id,
    oldName: oldName,
    newName: room.name,
    creatorId: room.creatorId,
    creatorName: room.creatorName,
    rooms: Array.from(rooms.values()).map(r => ({
      id: r.id,
      name: r.name,
      creatorId: r.creatorId,
      creatorName: r.creatorName,
      isPrivate: r.isPrivate,
      userCount: r.users.size
    }))
  }));
}

// 加入房间
function joinRoom(client, data) {
  const room = rooms.get(data.roomId);
  if (!room) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '房间不存在',
      code: 'room-not-found'
    }));
    return;
  }
  
  // 检查密码
  if (room.isPrivate && room.password !== data.password) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: '密码错误',
      code: 'wrong-password'
    }));
    return;
  }
  
  // 离开当前房间
  if (client.currentRoom) {
    const currentRoom = rooms.get(client.currentRoom);
    if (currentRoom) {
      currentRoom.users.delete(client.id);
      
      // 通知其他用户该用户已离开
      broadcastToRoom(currentRoom.id, {
        type: 'user-left',
        user: {
          id: client.id,
          name: client.name,
          avatar: client.avatar
        },
        userCount: currentRoom.users.size
      });
      
      // 更新房间人数
      broadcastRoomUserCount(currentRoom.id);
    }
  }
  
  // 加入新房间
  room.users.add(client.id);
  client.currentRoom = room.id;
  
  displayServerMessage(`${client.name} 加入房间: ${room.name} (${room.id})`);
  
  // 通知其他用户有新用户加入
  broadcastToRoom(room.id, {
    type: 'user-joined',
    user: {
      id: client.id,
      name: client.name,
      avatar: client.avatar
    },
    userCount: room.users.size
  }, client.id);
  
  // 发送房间历史消息
  client.ws.send(JSON.stringify({
    type: 'room-joined',
    roomId: room.id,
    roomName: room.name,
    creatorId: room.creatorId,
    creatorName: room.creatorName || '未知',
    isPrivate: room.isPrivate,
    userCount: room.users.size,
    history: room.history.slice(-50)
  }));
  
  // 更新房间人数
  broadcastRoomUserCount(room.id);
}

// 发送消息
function sendMessage(client, data) {
    if (!client.currentRoom) return;
    
    const room = rooms.get(client.currentRoom);
    if (!room) return;
    
    // 创建消息对象（包含客户端发来的ID）
    const message = {
        id: data.id || uuid.v4(), // 使用客户端提供的ID或生成新ID
        content: data.content,
        sender: {
            id: client.id,
            name: client.name,
            avatar: client.avatar,
            isCreator: client.id === room.creatorId
        },
        timestamp: Date.now()
    };
    
    // 添加到历史记录
    room.history.push(message);
    
    // 广播给房间内的所有用户（包括发送者）
    broadcastToRoom(room.id, {
        type: 'message',
        message: message
    });
}

// 发送图片
function sendImage(client, data) {

  if (!client.currentRoom) return;
  
  const room = rooms.get(client.currentRoom);
  if (!room) return;

  // 创建图片消息对象
  const message = {
    id: uuid.v4(),
    content: data.content,
    isImage: true,
    sender: {
      id: client.id,
      name: client.name,
      avatar: client.avatar,
      isCreator: client.id === room.creatorId
    },
    timestamp: Date.now()
  };
  
  // 添加到历史记录
  room.history.push(message);
  
  // 广播给房间内的所有用户
  broadcastToRoom(room.id, {
    type: 'image',
    content: data.content,
    sender: {
      id: client.id,
      name: client.name,
      avatar: client.avatar,
      isCreator: client.id === room.creatorId
    }
  });
}

// 广播消息给房间内的所有用户
function broadcastToRoom(roomId, data, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.users.forEach(clientId => {
    if (clientId === excludeClientId) return;
    
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  });
}

// 更新房间用户数
function broadcastRoomUserCount(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  broadcastToRoom(roomId, {
    type: 'room-user-count',
    roomId: roomId,
    userCount: room.users.size
  });
}

// 广播房间列表给所有客户端
function broadcastRoomList() {
  const roomList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    creatorId: room.creatorId,
    creatorName: room.creatorName || '未知',
    isPrivate: room.isPrivate,
    userCount: room.users.size
  }));
  
  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'room-list',
        rooms: roomList
      }));
    }
  });
}

// 更新在线人数并广播
function updateOnlineCount() {
  const count = clients.size;
  displayServerMessage(`当前在线人数: ${count}`);
  
  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'online-count',
        count: count
      }));
    }
  });
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  displayServerMessage(`服务器已启动，监听端口 ${PORT}`);
  console.log(`服务器已启动，监听端口 ${PORT}`);
});