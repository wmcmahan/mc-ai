import { describe, test, expect } from 'vitest';
import {
  WorkflowStateSchema,
  WorkflowStatusSchema,
  WaitingReasonSchema,
  ActionSchema,
} from '../src/types/state.js';
import {
  GraphSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  FailurePolicySchema,
  NodeTypeSchema,
} from '../src/types/graph.js';

describe('Type Validation (Zod Schemas)', () => {
  describe('WorkflowStatusSchema', () => {
    test('should accept valid statuses', () => {
      const validStatuses = [
        'pending',
        'scheduled',
        'running',
        'waiting',
        'retrying',
        'completed',
        'failed',
        'cancelled',
        'timeout',
      ];

      for (const status of validStatuses) {
        expect(() => WorkflowStatusSchema.parse(status)).not.toThrow();
      }
    });

    test('should reject invalid statuses', () => {
      expect(() => WorkflowStatusSchema.parse('invalid')).toThrow();
      expect(() => WorkflowStatusSchema.parse('RUNNING')).toThrow();
      expect(() => WorkflowStatusSchema.parse('')).toThrow();
    });
  });

  describe('WaitingReasonSchema', () => {
    test('should accept valid waiting reasons', () => {
      const validReasons = [
        'human_approval',
        'external_event',
        'scheduled_time',
        'rate_limit',
        'resource_limit',
      ];

      for (const reason of validReasons) {
        expect(() => WaitingReasonSchema.parse(reason)).not.toThrow();
      }
    });

    test('should reject invalid reasons', () => {
      expect(() => WaitingReasonSchema.parse('unknown')).toThrow();
    });
  });

  describe('WorkflowStateSchema', () => {
    test('should parse valid workflow state', () => {
      const validState = {
        workflow_id: '123e4567-e89b-12d3-a456-426614174000',
        run_id: '123e4567-e89b-12d3-a456-426614174001',
        created_at: new Date(),
        updated_at: new Date(),
        goal: 'Test goal',
        constraints: ['constraint1'],
        status: 'running',
        iteration_count: 5,
        retry_count: 0,
        max_retries: 3,
        memory: { test: 'value' },
        visited_nodes: ['node1', 'node2'],
        max_iterations: 50,
        compensation_stack: [],
        max_execution_time_ms: 3600000,
      };

      expect(() => WorkflowStateSchema.parse(validState)).not.toThrow();
    });

    test('should apply default values', () => {
      const minimalState = {
        workflow_id: '123e4567-e89b-12d3-a456-426614174000',
        run_id: '123e4567-e89b-12d3-a456-426614174001',
        created_at: new Date(),
        updated_at: new Date(),
        goal: 'Test',
        status: 'pending',
      };

      const parsed = WorkflowStateSchema.parse(minimalState);

      expect(parsed.iteration_count).toBe(0);
      expect(parsed.retry_count).toBe(0);
      expect(parsed.max_retries).toBe(3);
      expect(parsed.memory).toEqual({});
      expect(parsed.visited_nodes).toEqual([]);
      expect(parsed.max_iterations).toBe(50);
      expect(parsed.compensation_stack).toEqual([]);
      expect(parsed.max_execution_time_ms).toBe(3600000);
    });

    test('should reject missing required fields', () => {
      expect(() => WorkflowStateSchema.parse({})).toThrow();
      expect(() =>
        WorkflowStateSchema.parse({
          workflow_id: '123e4567-e89b-12d3-a456-426614174000',
          // Missing run_id
        })
      ).toThrow();
    });
  });

  describe('ActionSchema', () => {
    test('should parse valid action', () => {
      const validAction = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'update_memory',
        payload: { updates: { key: 'value' } },
        metadata: {
          node_id: 'test-node',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      expect(() => ActionSchema.parse(validAction)).not.toThrow();
    });

    test('should parse action with compensation', () => {
      const actionWithCompensation = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'charge_card',
        payload: { amount: 100 },
        compensation: {
          type: 'refund_card',
          payload: { amount: 100 },
        },
        metadata: {
          node_id: 'payment',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      expect(() => ActionSchema.parse(actionWithCompensation)).not.toThrow();
    });

    test('should apply default attempt value', () => {
      const action = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        idempotency_key: '123e4567-e89b-12d3-a456-426614174001',
        type: 'test',
        payload: {},
        metadata: {
          node_id: 'test',
          timestamp: new Date(),
        },
      };

      const parsed = ActionSchema.parse(action);
      expect(parsed.metadata.attempt).toBe(1);
    });
  });

  describe('NodeTypeSchema', () => {
    test('should accept valid node types', () => {
      const validTypes = ['agent', 'tool', 'subgraph', 'synthesizer', 'router'];

      for (const type of validTypes) {
        expect(() => NodeTypeSchema.parse(type)).not.toThrow();
      }
    });

    test('should reject invalid node types', () => {
      expect(() => NodeTypeSchema.parse('invalid')).toThrow();
    });
  });

  describe('FailurePolicySchema', () => {
    test('should parse valid failure policy', () => {
      const validPolicy = {
        max_retries: 5,
        backoff_strategy: 'exponential',
        initial_backoff_ms: 1000,
        max_backoff_ms: 60000,
        circuit_breaker: {
          enabled: true,
          failure_threshold: 5,
          success_threshold: 2,
          timeout_ms: 60000,
        },
        timeout_ms: 30000,
      };

      expect(() => FailurePolicySchema.parse(validPolicy)).not.toThrow();
    });

    test('should apply default values', () => {
      const parsed = FailurePolicySchema.parse({});

      expect(parsed.max_retries).toBe(3);
      expect(parsed.backoff_strategy).toBe('exponential');
      expect(parsed.initial_backoff_ms).toBe(1000);
      expect(parsed.max_backoff_ms).toBe(60000);
    });

    test('should validate backoff strategy enum', () => {
      expect(() =>
        FailurePolicySchema.parse({ backoff_strategy: 'invalid' })
      ).toThrow();

      expect(() =>
        FailurePolicySchema.parse({ backoff_strategy: 'linear' })
      ).not.toThrow();
    });
  });

  describe('GraphNodeSchema', () => {
    test('should parse valid graph node', () => {
      const validNode = {
        id: 'node-1',
        type: 'agent',
        agent_id: 'planner',
        read_keys: ['input'],
        write_keys: ['plan'],
        failure_policy: {
          max_retries: 3,
        },
        requires_compensation: false,
      };

      expect(() => GraphNodeSchema.parse(validNode)).not.toThrow();
    });

    test('should apply default values', () => {
      const minimalNode = {
        id: 'node-1',
        type: 'tool',
      };

      const parsed = GraphNodeSchema.parse(minimalNode);

      expect(parsed.read_keys).toEqual(['*']);
      expect(parsed.write_keys).toEqual([]);
      expect(parsed.requires_compensation).toBe(false);
      expect(parsed.failure_policy).toBeDefined();
    });
  });

  describe('GraphEdgeSchema', () => {
    test('should parse valid edge', () => {
      const validEdge = {
        id: 'e1',
        source: 'node1',
        target: 'node2',
        condition: { type: 'always' },
      };

      expect(() => GraphEdgeSchema.parse(validEdge)).not.toThrow();
    });

    test('should apply default condition', () => {
      const edge = {
        id: 'e1',
        source: 'node1',
        target: 'node2',
      };

      const parsed = GraphEdgeSchema.parse(edge);
      expect(parsed.condition.type).toBe('always');
    });
  });

  describe('GraphSchema', () => {
    test('should parse valid graph', () => {
      const validGraph = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Test Graph',
        description: 'A test graph',
        version: '1.0.0',
        nodes: [
          { id: 'start', type: 'agent' },
          { id: 'end', type: 'agent' },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'end' },
        ],
        start_node: 'start',
        end_nodes: ['end'],
        created_at: new Date(),
        updated_at: new Date(),
      };

      expect(() => GraphSchema.parse(validGraph)).not.toThrow();
    });

    test('should apply default version', () => {
      const graph = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        nodes: [],
        edges: [],
        start_node: 'start',
        end_nodes: [],
        created_at: new Date(),
        updated_at: new Date(),
      };

      const parsed = GraphSchema.parse(graph);
      expect(parsed.version).toBe('1.0.0');
    });
  });
});
