import { ContactSearch } from "@/lib/dto";
import { MPHelper } from "@/lib/providers/ministry-platform";
import { sanitizeLikeValue, sanitizeGuid } from "@/lib/providers/ministry-platform/utils/filter-sanitize";
import { SessionContextService } from "@/services/sessionContextService";

/**
 * ContactService - Singleton service for managing contact-related operations
 * 
 * This service provides methods to interact with contact data from Ministry Platform,
 * including searching for contacts and retrieving individual contact information.
 * Uses the singleton pattern to ensure a single instance across the application.
 */
export class ContactService {
  private static instance: ContactService;
  private mp: MPHelper | null = null;

  /**
   * Private constructor to enforce singleton pattern
   * Initializes the service when instantiated
   */
  private constructor() {
    this.initialize();
  }

  /**
   * Gets the singleton instance of ContactService
   * Creates a new instance if one doesn't exist and ensures it's properly initialized
   * 
   * @returns Promise<ContactService> - The initialized ContactService instance
   */
  public static async getInstance(): Promise<ContactService> {
    if (!ContactService.instance) {
      ContactService.instance = new ContactService();
      await ContactService.instance.initialize();
    }
    return ContactService.instance;
  }

  /**
   * Initializes the ContactService by creating a new MPHelper instance
   * This method sets up the Ministry Platform connection helper
   * 
   * @returns Promise<void>
   */
  private async initialize(): Promise<void> {
    this.mp = new MPHelper();
  }

  /**
   * Searches for contacts based on a search term
   * Performs a fuzzy search across multiple contact fields including name, email, and phone
   * 
   * @param search - The search term to match against contact fields
   * @returns Promise<ContactSearch[]> - Array of matching contacts (limited to 20 results)
   */
  public async contactSearch(search: string): Promise<ContactSearch[]> {
    const term = sanitizeLikeValue(search);
    const filter = ["First_Name", "Last_Name", "Nickname", "Email_Address", "Mobile_Phone"]
      .map((col) => `${col} LIKE '%${term}%' ESCAPE '\\'`)
      .join(" OR ");
    const records = await this.mp!.getTableRecords<ContactSearch>({
      table: "Contacts",
      filter,
      select: "Contact_ID, Contact_GUID,First_Name,Nickname,Last_Name,Email_Address,Mobile_Phone,dp_fileUniqueId AS Image_GUID",
      top: 20
    });
    
    return records;
  }

  /**
   * Retrieves a specific contact by their GUID
   * 
   * @param contactGuid - The unique GUID identifier for the contact
   * @returns Promise<ContactSearch | null> - The matching contact record or null if not found
   */
  public async getContactByGuid(contactGuid: string): Promise<ContactSearch | null> {
    const records = await this.mp!.getTableRecords<ContactSearch>({
      table: "Contacts",
      filter: `Contact_GUID = '${sanitizeGuid(contactGuid)}'`,
      select: "Contact_ID, Contact_GUID,First_Name,Nickname,Last_Name,Email_Address,Mobile_Phone,dp_fileUniqueId AS Image_GUID",
      top: 1
    });
    
    // Return the first (and should be only) matching record, or null if not found
    return records.length > 0 ? records[0] : null;
  }

  /**
   * Updates specific fields for a contact
   * 
   * @param contactId - The Contact_ID of the contact to update
   * @param fields - Partial object containing the fields to update (Email_Address, Mobile_Phone)
   * @returns Promise<void>
   */
  public async updateContact(
    contactId: number,
    fields: Partial<Pick<ContactSearch, "Email_Address" | "Mobile_Phone">>
  ): Promise<void> {
    const record = { Contact_ID: contactId, ...fields };

    const $userId = await SessionContextService.getInstance().getActingUserIdForWrite({
      table: "Contacts",
      operation: "update",
    });

    await this.mp!.updateTableRecords(
      "Contacts",
      [record],
      $userId !== null ? { $userId } : undefined
    );
  }

  /**
   * Looks up a single Contact by phone number for inbound caller-ID resolution
   * (e.g. the parish emergency line). Matches Mobile, Company, and Household
   * Home phone. Normalizes any input — including Twilio E.164 like
   * "+14023508149" — to MP's stored dashed format ("402-350-8149") by taking
   * the last 10 digits. The matched value contains only digits and dashes, so
   * it is injection-safe by construction.
   *
   * @param phone - phone number in any format
   * @returns Promise<ContactSearch | null> - the matched contact, or null
   *          (callers should fall back to the Unassigned Contact, ID 10)
   */
  public async getContactByPhone(phone: string): Promise<ContactSearch | null> {
    const digits = (phone || "").replace(/\D/g, "");
    const last10 = digits.slice(-10);
    if (last10.length !== 10) return null;
    const dashed = `${last10.slice(0, 3)}-${last10.slice(3, 6)}-${last10.slice(6)}`;

    const records = await this.mp!.getTableRecords<ContactSearch>({
      table: "Contacts",
      filter:
        `Mobile_Phone = '${dashed}' OR Company_Phone = '${dashed}' ` +
        `OR Household_ID_Table.Home_Phone = '${dashed}'`,
      select:
        "Contact_ID, Contact_GUID, First_Name, Nickname, Last_Name, Email_Address, Mobile_Phone, dp_fileUniqueId AS Image_GUID",
      top: 1,
    });

    return records.length > 0 ? records[0] : null;
  }
}