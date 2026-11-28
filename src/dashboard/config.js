// RUSHED scouting dashboard — site settings.
// Fill in the two Supabase values (Supabase → Project Settings → API). Both are meant to be
// public: the database rules in supabase/setup.sql decide what each person can see and do.
window.RUSHED_DASH = {
  supabaseUrl: '',      // e.g. 'https://abcdefghijkl.supabase.co'
  supabaseAnonKey: '',  // the "anon" / "publishable" key

  // Where new scouts open a ticket so an owner can verify them.
  accessTicketUrl: 'https://discord.com/channels/1573726328954294395/1573728940281827328',
  accessTicketName: '#🎫│d-access',
  // Link back to the main RUSHED website.
  mainSiteUrl: '../'
};
