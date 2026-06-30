import { describe, it, expect, vi } from 'vitest';
import { resolveAudience } from './broadcast-sender';

describe('broadcast-sender', () => {
  describe('resolveAudience', () => {
    it('resolves all contacts correctly', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          data: [
            { id: '1', name: 'John', phone: '12345', account_id: 'acc1' },
            { id: '2', name: 'Jane', phone: '67890', account_id: 'acc1' }
          ],
          error: null
        })
      };

      const contacts = await resolveAudience(mockSupabase, { type: 'all' }, 'acc1');
      expect(contacts).toHaveLength(2);
      expect(mockSupabase.from).toHaveBeenCalledWith('contacts');
      expect(mockSupabase.eq).toHaveBeenCalledWith('account_id', 'acc1');
    });

    it('resolves audience with tags correctly', async () => {
      const mockSupabase = {
        from: vi.fn((table) => {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn((col, val) => {
              if (table === 'contact_tags') {
                return Promise.resolve({
                  data: [{ contact_id: 'c1' }, { contact_id: 'c2' }],
                  error: null
                });
              } else if (table === 'contacts') {
                return {
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { id: 'c1', name: 'John', account_id: 'acc1' },
                      { id: 'c2', name: 'Jane', account_id: 'acc1' }
                    ],
                    error: null
                  })
                };
              }
              return Promise.resolve({ data: [], error: null });
            })
          };
        })
      };

      const contacts = await resolveAudience(mockSupabase, { type: 'tags', tagIds: ['t1'] }, 'acc1');
      expect(contacts).toHaveLength(2);
    });

    it('resolves CSV audience correctly, looking up existing and inserting missing', async () => {
      const mockContacts = [
        { id: 'existing-id', phone: '11111', name: 'Existing User', account_id: 'acc1' }
      ];
      
      const mockSupabase = {
        from: vi.fn((table) => {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockImplementation((col, vals) => {
              if (table === 'contacts') {
                // Return matched existing contacts
                const matched = mockContacts.filter(c => vals.includes(c.phone));
                return Promise.resolve({ data: matched, error: null });
              }
              return Promise.resolve({ data: [], error: null });
            }),
            insert: vi.fn().mockImplementation((rows) => {
              const inserted = rows.map((r: any, i: number) => ({
                id: `new-id-${i}`,
                ...r
              }));
              mockContacts.push(...inserted);
              return {
                select: vi.fn().mockResolvedValue({ data: inserted, error: null })
              };
            })
          };
        })
      };

      const audience = {
        type: 'csv',
        csvContacts: [
          { phone: '11111', name: 'Existing User' },
          { phone: '22222', name: 'New User' }
        ]
      };

      const contacts = await resolveAudience(mockSupabase, audience, 'acc1', 'user1');
      expect(contacts).toHaveLength(2);
      expect(contacts[0].id).toBe('existing-id');
      expect(contacts[1].id).toBe('new-id-0');
      expect(contacts[1].phone).toBe('22222');
      expect(contacts[1].user_id).toBe('user1');
    });
  });
});
