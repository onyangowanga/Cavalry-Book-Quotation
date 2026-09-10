import javax.swing.*;
import javax.swing.table.DefaultTableModel;
import javax.swing.event.TableModelEvent;
import javax.swing.event.TableModelListener;
import javax.swing.event.DocumentListener;
import javax.swing.event.DocumentEvent;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.text.DecimalFormat;
import java.util.List;
import java.util.stream.Collectors;

/**
 * QuoteBuilderDialog.java - A modal dialog for managing the final quote 
 * (shopping cart), adjusting quantities, applying discounts, and sending the quote.
 *
 * FIXES & FEATURES:
 * 1. FIXED: Layout conflict causing the bottom panels (Client/Totals) to disappear.
 * 2. CORRECTED: 6-argument constructor signature.
 * 3. FIXED: Added the missing QuoteTableChangeListener class.
 */
public class QuoteBuilderDialog extends JDialog {
    
    // --- Services and State ---
    private final CatalogueManager parent;
    private final List<QuoteItem> quoteItems; // The current items in the cart
    private final List<Book> catalogue;       // The master list of all available books 
    private final double minimumCost;
    private final String tillNumber;
    private final String defaultSenderPhone; 

    // --- UI Components ---
    private JTable quoteTable;
    private DefaultTableModel tableModel; 
    private JList<Book> catalogueList; 
    private JTextField discountField; 
    private JTextField clientNameField;
    private JTextField clientPhoneField; 
    private JLabel subtotalLabel;
    private JLabel totalLabel;
    private JLabel finalTotal;
    
    // Global format for currency/costs
    private static final DecimalFormat DECIMAL_FORMAT = new DecimalFormat("###,##0.00");


    /**
     * CORRECTED CONSTRUCTOR SIGNATURE (6 arguments)
     */
    public QuoteBuilderDialog(CatalogueManager parent, List<QuoteItem> quoteItems, List<Book> catalogue, double minimumCost, String tillNumber, String defaultSenderPhone) {
        super(parent, "Quote Builder & Sender", true); // Modal dialog
        this.parent = parent;
        this.quoteItems = quoteItems;
        this.catalogue = catalogue; 
        this.minimumCost = minimumCost;
        this.tillNumber = tillNumber;
        this.defaultSenderPhone = defaultSenderPhone;

        initUI();
        recalculateTotals(); 
    }

    private void initUI() {
        setLayout(new BorderLayout(10, 10));
        getRootPane().setBorder(BorderFactory.createEmptyBorder(15, 15, 15, 15));

        // --- 1. Top Panel: Quote Table & Catalogue List (Shopping Area) ---
        JPanel shoppingPanel = new JPanel(new BorderLayout(10, 10));

        // --- Left: Quote Table (The Cart) ---
        JPanel quoteTablePanel = new JPanel(new BorderLayout());
        String[] columnNames = {"Book Name", "Unit Cost (Kshs.)", "Quantity", "Line Total (Kshs.)"};
        
        tableModel = new DefaultTableModel(columnNames, 0) {
            @Override
            public boolean isCellEditable(int row, int column) {
                return column == 2; // Allow editing only for Quantity
            }
            
            @Override
            public Class<?> getColumnClass(int columnIndex) {
                return columnIndex == 2 ? Integer.class : super.getColumnClass(columnIndex);
            }
        };
        
        quoteTable = new JTable(tableModel);
        quoteTable.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        quoteTable.getModel().addTableModelListener(new QuoteTableChangeListener()); 
        
        populateQuoteTable();

        quoteTablePanel.add(new JScrollPane(quoteTable), BorderLayout.CENTER);
        
        JButton removeButton = new JButton("Remove Selected Book");
        removeButton.setBackground(new Color(60, 100, 200));
        // removeButton.setForeground(Color.WHITE);
        Font buttonFont = new Font("SansSerif", Font.BOLD, 12);
        removeButton.setFont(buttonFont);

        removeButton.addActionListener(this::removeBookAction);
        quoteTablePanel.add(removeButton, BorderLayout.SOUTH);
        
        shoppingPanel.add(quoteTablePanel, BorderLayout.CENTER);

        // --- Right: Add Book Panel (Catalogue Selector) ---
        JPanel addBookPanel = new JPanel(new BorderLayout(5, 5));
        
        DefaultListModel<Book> listModel = new DefaultListModel<>();
        for (Book book : catalogue) {
            listModel.addElement(book);
        }
        
        catalogueList = new JList<>(listModel);
        catalogueList.setCellRenderer(new BookListRenderer());
        catalogueList.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);

        JButton addButton = new JButton("Add Selected Book to Quote");
        addButton.addActionListener(this::addBookAction);
        
        addBookPanel.add(new JLabel("Available Books (Catalogue):"), BorderLayout.NORTH);
        addBookPanel.add(new JScrollPane(catalogueList), BorderLayout.CENTER);
        addBookPanel.add(addButton, BorderLayout.SOUTH);
        
        shoppingPanel.add(addBookPanel, BorderLayout.EAST);
        
        // ----------------------------------------------------------------------------------
        // --- 2. Bottom Panel: Input and Totals (Was in CENTER, now part of SOUTH) ---
        // ----------------------------------------------------------------------------------
        JPanel bottomPanel = new JPanel(new BorderLayout(10, 10));
        
        // Client Info Panel
        JPanel clientPanel = new JPanel(new GridLayout(2, 2, 5, 5));
        clientNameField = new JTextField(15);
        clientPhoneField = new JTextField(15);
        
        clientPhoneField.setText(defaultSenderPhone); 
        
        clientPanel.add(new JLabel("Client Name:"));
        clientPanel.add(clientNameField);
        clientPanel.add(new JLabel("Phone Number:"));
        clientPanel.add(clientPhoneField);
        
        // Totals and Discount Panel
        JPanel totalsPanel = new JPanel(new GridLayout(3, 2, 5, 5));
        
        discountField = new JTextField("0.0", 15); 
        discountField.setEnabled(true); 
        discountField.getDocument().addDocumentListener(new RecalculateDocumentListener());
        
        subtotalLabel = new JLabel("Kshs. 0.00");
        totalLabel = new JLabel("Kshs. 0.00");
        
        totalsPanel.add(new JLabel("Subtotal:"));
        totalsPanel.add(subtotalLabel);
        totalsPanel.add(new JLabel("Discount (Kshs. - Adjust Manually):")); 
        totalsPanel.add(discountField);
        finalTotal = new JLabel("FINAL TOTAL:");
        totalsPanel.add(finalTotal);
        totalsPanel.add(totalLabel);
        Font LabelFont = new Font("SansSerif", Font.BOLD, 18);
        finalTotal.setFont(LabelFont);
        totalLabel.setFont(LabelFont);
        totalLabel.setForeground(new Color(40, 170, 70));
        finalTotal.setForeground(new Color(40, 170, 70));
        
        bottomPanel.add(clientPanel, BorderLayout.NORTH);
        bottomPanel.add(totalsPanel, BorderLayout.CENTER);

        // --- 3. Action Panel ---
        JButton sendButton = new JButton("Send Quote on WhatsApp");
        sendButton.addActionListener(this::sendQuoteAction);
        
        JPanel actionPanel = new JPanel(new FlowLayout(FlowLayout.CENTER));
        actionPanel.add(sendButton);

        // ----------------------------------------------------------------------------------
        // --- Final Assembly (Layout Fix) ---
        // ----------------------------------------------------------------------------------
        
        // Combine all control panels (client info, totals, send button) into a single container
        JPanel southContainer = new JPanel();
        // Use BoxLayout vertically to stack the input panels on top of the button
        southContainer.setLayout(new BoxLayout(southContainer, BoxLayout.Y_AXIS)); 
        southContainer.add(bottomPanel);
        southContainer.add(actionPanel);

        // 1. Place the main data/scrolling area in the CENTER
        add(shoppingPanel, BorderLayout.CENTER); 
        // 2. Place the control/input area in the SOUTH
        add(southContainer, BorderLayout.SOUTH); 

        setPreferredSize(new Dimension(850, 600)); 
        pack();
        setLocationRelativeTo(parent);
    }
    
    // ... (All other helper and nested classes remain the same, including the required listeners) ...

    /**
     * Custom List Renderer to display Book details in the catalogue list.
     */
    private class BookListRenderer extends DefaultListCellRenderer {
        @Override
        public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean isSelected, boolean cellHasFocus) {
            super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus);
            if (value instanceof Book) {
                Book book = (Book) value;
                String text = String.format("%s (Kshs. %s)", 
                    book.getBookName(), 
                    DECIMAL_FORMAT.format(book.getCostPerBook()));
                setText(text);
            }
            return this;
        }
    }
    
    private void populateQuoteTable() {
        tableModel.setRowCount(0); 
        for (QuoteItem item : quoteItems) {
            Object[] row = new Object[] {
                item.getBook().getBookName(),
                DECIMAL_FORMAT.format(item.getBook().getCostPerBook()),
                item.getQuantity(),
                DECIMAL_FORMAT.format(item.getLineTotal())
            };
            tableModel.addRow(row);
        }
    }
    
    private void addBookAction(ActionEvent e) {
        Book selectedBook = catalogueList.getSelectedValue();
        if (selectedBook == null) {
            JOptionPane.showMessageDialog(this, "Please select a book from the catalogue to add.", "Selection Required", JOptionPane.WARNING_MESSAGE);
            return;
        }

        for (QuoteItem item : quoteItems) {
            if (item.getBook().getBookName().equals(selectedBook.getBookName())) {
                JOptionPane.showMessageDialog(this, "Book is already in the quote. Adjust the quantity directly in the quote table.", "Already Added", JOptionPane.INFORMATION_MESSAGE);
                return;
            }
        }
        
        try {
            QuoteItem newItem = new QuoteItem(selectedBook, 1);
            quoteItems.add(newItem);
            populateQuoteTable();
            recalculateTotals(); 
        } catch (IllegalArgumentException ex) {
            JOptionPane.showMessageDialog(this, "Error adding book: " + ex.getMessage(), "Error", JOptionPane.ERROR_MESSAGE);
        }
    }
    
    private void removeBookAction(ActionEvent e) {
        int selectedRow = quoteTable.getSelectedRow();
        if (selectedRow == -1) {
            JOptionPane.showMessageDialog(this, "Please select a row in the quote table to remove.", "Selection Required", JOptionPane.WARNING_MESSAGE);
            return;
        }

        quoteItems.remove(selectedRow);
        tableModel.removeRow(selectedRow);
        recalculateTotals();
    }

    /**
     * Recalculates the subtotal, applies discount (from the field), and determines the final total.
     */
    private void recalculateTotals() {
        // 1. Calculate Subtotal
        double subtotal = quoteItems.stream()
            .mapToDouble(QuoteItem::getLineTotal)
            .sum();
        
        // 2. Read Discount from the editable field
        double discount = 0.0;
        try {
            String discountText = discountField.getText().trim();
            if (!discountText.isEmpty()) {
                discount = Double.parseDouble(discountText);
                if (discount < 0) discount = 0.0;
            }
        } catch (NumberFormatException e) {
            // Ignore non-numeric input for real-time update
        }
        
        // 3. Calculate Pre-Final Total
        double preFinalTotal = subtotal - discount;

        // 4. Apply Minimum Cost Rule (400.00)
        double finalTotal = (preFinalTotal < minimumCost) ? minimumCost : preFinalTotal;
        
        // 5. Update Labels (Real-time update)
        subtotalLabel.setText("Kshs. " + DECIMAL_FORMAT.format(subtotal));
        totalLabel.setText("Kshs. " + DECIMAL_FORMAT.format(finalTotal));
    }
    
    /**
     * Listens for changes in the discount text field to trigger recalculation.
     */
    private class RecalculateDocumentListener implements DocumentListener {
        private void recalculateIfValid() {
            SwingUtilities.invokeLater(() -> {
                try {
                    if (!discountField.getText().trim().isEmpty()) {
                        Double.parseDouble(discountField.getText().trim());
                    }
                    recalculateTotals();
                } catch (NumberFormatException ex) {
                    // Do nothing during user typing if invalid format is transient
                }
            });
        }
        @Override public void insertUpdate(DocumentEvent e) { recalculateIfValid(); }
        @Override public void removeUpdate(DocumentEvent e) { recalculateIfValid(); }
        @Override public void changedUpdate(DocumentEvent e) { recalculateIfValid(); }
    }
    
    /**
     * Nested class to listen for quantity changes in the JTable.
     */
    private class QuoteTableChangeListener implements TableModelListener {
        @Override
        public void tableChanged(TableModelEvent e) {
            // Only update if quantity column (index 2) was changed
            if (e.getType() == TableModelEvent.UPDATE && e.getColumn() == 2) {
                int row = e.getFirstRow();
                try {
                    // 1. Get the new quantity from the table
                    int newQuantity = (Integer) tableModel.getValueAt(row, 2);
                    
                    // 2. Update the corresponding QuoteItem object's quantity
                    QuoteItem item = quoteItems.get(row);
                    item.setQuantity(newQuantity);
                    
                    // 3. Recalculate line total and update the table cell
                    double newLineTotal = item.getLineTotal();
                    tableModel.setValueAt(DECIMAL_FORMAT.format(newLineTotal), row, 3);
                    
                    // 4. Recalculate the grand totals
                    recalculateTotals();
                    
                } catch (NumberFormatException | ClassCastException ex) {
                    // Revert the cell if invalid input was provided (e.g., text instead of number)
                    JOptionPane.showMessageDialog(QuoteBuilderDialog.this, "Invalid quantity entered. Please use whole numbers.", "Input Error", JOptionPane.ERROR_MESSAGE);
                    // Reload the original quantity to correct the cell
                    tableModel.setValueAt(quoteItems.get(row).getQuantity(), row, 2);
                } catch (IllegalArgumentException ex) {
                    // Handle quantity <= 0
                    JOptionPane.showMessageDialog(QuoteBuilderDialog.this, ex.getMessage(), "Input Error", JOptionPane.ERROR_MESSAGE);
                    // Reload the original quantity to correct the cell
                    tableModel.setValueAt(quoteItems.get(row).getQuantity(), row, 2);
                }
            }
        }
    }


    /**
     * Handles the action of sending the final quote via WhatsApp.
     */
    private void sendQuoteAction(ActionEvent e) {
        String clientName = clientNameField.getText().trim();
        String clientPhone = clientPhoneField.getText().trim();
        
        if (clientName.isEmpty()) {
            JOptionPane.showMessageDialog(this, "Please enter the client's name.", "Input Required", JOptionPane.WARNING_MESSAGE);
            return;
        }
        if (clientPhone.isEmpty() || !clientPhone.matches("^\\+?\\d.*")) { 
             JOptionPane.showMessageDialog(this, "Please enter a valid phone number (e.g., +2547...).", "Input Required", JOptionPane.WARNING_MESSAGE);
             return; 
        }
        if (quoteItems.isEmpty()) {
             JOptionPane.showMessageDialog(this, "Cannot send an empty quote. Please add books first.", "Quote Empty", JOptionPane.WARNING_MESSAGE);
             return; 
        }

        // 1. Get final validated discount
        double finalDiscount = 0.0;
        try {
            String discountText = discountField.getText().trim();
            if (!discountText.isEmpty()) {
                finalDiscount = Double.parseDouble(discountText);
            }
            if (finalDiscount < 0) {
                 throw new NumberFormatException("Discount cannot be negative.");
            }
        } catch (NumberFormatException ex) {
            JOptionPane.showMessageDialog(this, 
                "Please enter a valid numeric discount amount (e.g., 50.00).", 
                "Invalid Discount Input", JOptionPane.WARNING_MESSAGE);
            discountField.requestFocus();
            return;
        }

        // 2. Calculate Final Total with the validated discount
        double subtotal = quoteItems.stream().mapToDouble(QuoteItem::getLineTotal).sum();
        double preFinalTotal = subtotal - finalDiscount;
        double finalTotal = (preFinalTotal < minimumCost) ? minimumCost : preFinalTotal;
        
        // 3. Pass final, calculated data and inputs to the CatalogueManager method
        parent.createAndSendQuoteMessage(
            quoteItems.stream()
                      .filter(item -> item.getQuantity() > 0)
                      .collect(Collectors.toList()), 
            finalDiscount, 
            finalTotal, 
            clientName, 
            clientPhone
        );
        
        dispose();
    }
}