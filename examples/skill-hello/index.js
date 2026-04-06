export default async function createSkill() {
  return {
    name: 'hello-skill',
    version: '1.0.0',
    description: 'A simple hello world skill',
    
    commands: [
      {
        name: 'hello',
        description: 'Say hello to someone',
        handler: async (args, ctx) => {
          const name = args[0] || 'World';
          return `Hello, ${name}! 👋`;
        }
      },
      {
        name: 'greet',
        description: 'Greet with custom message',
        handler: async (args, ctx) => {
          const [name, ...rest] = args;
          const greeting = rest.join(' ') || 'Welcome!';
          return `Hey ${name || 'there'}! ${greeting}`;
        }
      }
    ],

    tools: [
      {
        name: 'hello_world',
        description: 'Return a hello world message',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name to greet'
            }
          }
        },
        handler: async (args, ctx) => {
          const name = args.name || 'World';
          return {
            content: [{ type: 'text', text: `Hello, ${name}! This is a skill tool.` }]
          };
        }
      },
      {
        name: 'get_workspace_info',
        description: 'Get information about the current workspace',
        inputSchema: {
          type: 'object',
          properties: {}
        },
        handler: async (args, ctx) => {
          return {
            content: [{
              type: 'text',
              text: `Workspace: ${ctx.workspace}\nSkills directory: ${ctx.skillsDir}`
            }]
          };
        }
      }
    ],

    hooks: {
      onStart: async (ctx) => {
        console.log('Hello skill loaded!');
      },
      
      onMessage: async (message, ctx) => {
        if (message.toLowerCase() === 'ping') {
          return 'Pong! 🏓';
        }
        return null;
      },
      
      onToolCall: async (name, args, ctx) => {
        return null;
      },
      
      onShutdown: async (ctx) => {
        console.log('Hello skill unloading...');
      }
    }
  };
}
